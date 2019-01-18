import { pushOpcode, pushOpcodeValue } from "../opcodes";
import { assertType, getTypeAnnotationForExpression } from "../annotations";
import {
  getBindingPathRef,
  getReferenceFromExpression,
  isDestructuredRef,
  isIdentifierReferenceConstant,
} from "../references";
import {
  emptyObject,
  escapeText,
  getAllPathsFromMutatedBinding,
  getCachedRuntimeValue,
  getCodeLocation,
  getComponentName,
  getRuntimeValueHash,
  getRuntimeValueIndex,
  getRuntimeValueIndexForPropsArray,
  handleWhiteSpace,
  isArrayMapConstructorTemplate,
  isCommonJsLikeRequireCall,
  isConditionalComponentType,
  isHostComponentType,
  isNodeWithinReactElementTemplate,
  isObjectAssignCall,
  isOpcodesTemplateFromFuncCall,
  isPrimitive,
  isReactCreateElement,
  isReactFragment,
  joinPathConditions,
  markNodeAsDCE,
  markNodeAsUsed,
  moveOutCallExpressionFromTemplate,
  moveOutFunctionFromTemplate,
  normalizeOpcodes,
  pathContainsReactElement,
  updateCommonJSLikeRequireCallPathToCompiledPath,
  updateImportSyntaxPathToCompiledPath,
  isFbCxCall,
} from "../utils";
import {
  getContextObjectRuntimeValueIndex,
  isReferenceReactContextConsumer,
  isReferenceReactContextProvider,
} from "./context";
import { createOpcodesForReactContextConsumer } from "./context";
import {
  createOpcodesForConditionalExpressionTemplate,
  createOpcodesForLogicalExpressionTemplate,
  createOpcodesForMutatedBinding,
  createOpcodesForNode,
} from "../nodes";
import { dangerousStyleValue, hyphenateStyleName } from "./style";
import { createOpcodesForReactFunctionComponent, createOpcodesForReactComputeFunction } from "./functions";
import { getPropInformation, isUnitlessNumber, transformStaticOpcodes } from "./prop-information";
import { validateArgumentsDoNotContainTemplateNodes, validateParamsDoNotConflictOuterScope } from "../validation";
import invariant from "../invariant";
import * as t from "@babel/types";
import { createOpcodesForCxMockCall } from "../mocks/cx";

const emptyPlaceholderNode = t.nullLiteral();
const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "command",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function createOpcodesForArrayMapTemplate(childPath, opcodes, state, componentPath) {
  const args = childPath.get("arguments");
  const calleePath = childPath.get("callee");
  let arrayPath;

  if (t.isMemberExpression(calleePath.node)) {
    arrayPath = calleePath.get("object");
  } else {
    invariant(false, "TODO");
  }

  const mapFunctionPath = getReferenceFromExpression(args[0], state);
  const { isStatic, templateOpcodes } = createOpcodesForReactComputeFunction(mapFunctionPath, state, false, null, null);
  const arrayRuntimeValuePointer = getRuntimeValueIndex(arrayPath.node, state);
  pushOpcodeValue(opcodes, arrayRuntimeValuePointer);
  pushOpcodeValue(opcodes, normalizeOpcodes(templateOpcodes), "ARRAY_MAP_OPCODES");
  if (isStatic) {
    pushOpcodeValue(opcodes, t.numericLiteral(0), "ARRAY_MAP_COMPUTE_FUNCTION");
  } else {
    let nodeToReference = mapFunctionPath.node;
    if (t.isFunctionDeclaration(nodeToReference)) {
      nodeToReference = nodeToReference.id;
    }
    const mapFunctionValuePointer = getRuntimeValueIndex(nodeToReference, state);
    pushOpcodeValue(opcodes, mapFunctionValuePointer, "ARRAY_MAP_COMPUTE_FUNCTION");
  }
}

function createOpcodesForReactElementHostNodePropValue(
  hostNodeId,
  tagName,
  valuePath,
  propNameStr,
  opcodes,
  state,
  componentPath,
) {
  markNodeAsDCE(valuePath.node);
  const valueRefPath = getReferenceFromExpression(valuePath, state);
  const typeAnnotation = getTypeAnnotationForExpression(valueRefPath, state);

  if (
    t.isIdentifier(valueRefPath.node) &&
    !isIdentifierReferenceConstant(valueRefPath, state)
    // assertType(valueRefPath, typeAnnotation, true, state, "REACT_NODE") // we need to do this
  ) {
    createOpcodesForMutatedBinding(valueRefPath, opcodes, state, componentPath, (path, pathOpcodes) => {
      createOpcodesForReactElementHostNodePropValue(
        hostNodeId,
        tagName,
        path,
        propNameStr,
        pathOpcodes,
        state,
        componentPath,
      );
    });
    return;
  }

  if (propNameStr === "style") {
    if (t.isObjectExpression(valueRefPath.node)) {
      createOpcodesForHostNodeStylesObject(hostNodeId, valuePath, valueRefPath, opcodes, state, componentPath);
      return;
    } else if (t.isIdentifier(valueRefPath.node)) {
      if (t.isObjectTypeAnnotation(typeAnnotation)) {
        createOpcodesForHostNodeStylesIdentifier(
          hostNodeId,
          typeAnnotation,
          valuePath,
          valueRefPath,
          opcodes,
          state,
          componentPath,
        );
        return;
      }
    }
  }

  let attributeOpcodes = [];
  const runtimeValueHash = getRuntimeValueHash(state);

  if (isFbCxCall(valuePath, state)) {
    createOpcodesForCxMockCall(valueRefPath, attributeOpcodes, state);
  } else {
    createOpcodesForNode(valuePath, valueRefPath, attributeOpcodes, state, componentPath, false, value => {
      if (t.isStringLiteral(value)) {
        return t.stringLiteral(escapeText(value.value));
      } else if (t.isNumericLiteral(value)) {
        return t.stringLiteral(value);
      } else if (typeof value === "string") {
        return escapeText(value);
      }
      return value;
    });
  }
  let isPartialTemplate = false;
  // If there are no opcodes then early continue.
  if (t.isCallExpression(valueRefPath.node) && isOpcodesTemplateFromFuncCall(attributeOpcodes)) {
    // We don't want the first opcode, as that is TEMPLATE_FROM_FUNC_CALL
    const [, ...extractedOpcodes] = attributeOpcodes;
    attributeOpcodes = extractedOpcodes;
    isPartialTemplate = true;
  }
  const [propName, propInformation, eventInformation] = getPropInformation(propNameStr, isPartialTemplate);

  // Static vs dynamic
  if (!isPartialTemplate && runtimeValueHash === getRuntimeValueHash(state)) {
    const transformedStaticOpcodes = transformStaticOpcodes(attributeOpcodes, propInformation);

    if (transformedStaticOpcodes === null) {
      return;
    }
    if (propNameStr === "className" || propNameStr === "class") {
      pushOpcode(opcodes, "STATIC_PROP_CLASS_NAME", attributeOpcodes);
    } else if (propNameStr === "value") {
      if (tagName === "textarea") {
        pushOpcode(opcodes, "ELEMENT_STATIC_CHILDREN_VALUE", attributeOpcodes);
      } else {
        pushOpcode(opcodes, "STATIC_PROP_VALUE", attributeOpcodes);
      }
    } else if (propNameStr === "key") {
      // pushOpcode(opcodes, "STATIC_PROP_KEY", attributeOpcodes);
    } else if (propNameStr === "ref") {
      throw new Error(
        `The compiler does not support string refs on React Elements at ${getCodeLocation(valueRefPath.node)}`,
      );
    } else {
      pushOpcode(opcodes, "STATIC_PROP", [propName, ...transformedStaticOpcodes]);
    }
  } else {
    const propInformationLiteral = t.numericLiteral(propInformation);
    if (propNameStr === "className" || propNameStr === "class") {
      pushOpcode(opcodes, "DYNAMIC_PROP_CLASS_NAME", [propInformationLiteral, ...attributeOpcodes]);
      state.dynamicHostNodesId.add(hostNodeId);
    } else if (propNameStr === "value") {
      if (tagName === "textarea") {
        pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILDREN_VALUE", attributeOpcodes);
        const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
        pushOpcodeValue(opcodes, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
      } else {
        pushOpcode(opcodes, "DYNAMIC_PROP_VALUE", [propInformationLiteral, ...attributeOpcodes]);
        state.dynamicHostNodesId.add(hostNodeId);
      }
    } else if (propNameStr === "key") {
      // pushOpcode(opcodes, "DYNAMIC_PROP_KEY", [propInformationLiteral, ...attributeOpcodes]);
    } else if (propNameStr === "ref") {
      pushOpcode(opcodes, "DYNAMIC_PROP_REF", [propInformationLiteral, ...attributeOpcodes]);
    } else {
      if (eventInformation !== null) {
        const eventInformationLiteral = t.numericLiteral(eventInformation);
        pushOpcode(opcodes, "DYNAMIC_PROP", [
          propName,
          propInformationLiteral,
          eventInformationLiteral,
          ...attributeOpcodes,
        ]);
      } else {
        pushOpcode(opcodes, "DYNAMIC_PROP", [propName, propInformationLiteral, ...attributeOpcodes]);
      }
      state.dynamicHostNodesId.add(hostNodeId);
    }
  }
}

function createOpcodesForReactElementHostNodeChild(hostNodeId, childPath, onlyChild, opcodes, state, componentPath) {
  markNodeAsDCE(childPath.node);
  let refChildPath = getReferenceFromExpression(childPath, state);

  if (isDestructuredRef(refChildPath)) {
    refChildPath = refChildPath.property;
  }
  const typeAnnotation = getTypeAnnotationForExpression(refChildPath, state);
  const runtimeValueHash = getRuntimeValueHash(state);
  const childNode = refChildPath.node;

  if (
    t.isIdentifier(childNode) &&
    !isIdentifierReferenceConstant(refChildPath, state) &&
    assertType(childPath, typeAnnotation, true, state, "REACT_NODE")
  ) {
    const possiblyNull = createOpcodesForMutatedBinding(
      refChildPath,
      opcodes,
      state,
      componentPath,
      (path, pathOpcodes) => {
        createOpcodesForReactElementHostNodeChild(hostNodeId, path, onlyChild, pathOpcodes, state, componentPath);
      },
    );
    if (possiblyNull !== null) {
      return;
    }
  }

  if (t.isConditionalExpression(childNode) && assertType(childPath, typeAnnotation, true, state, "REACT_NODE")) {
    markNodeAsDCE(childNode);
    createOpcodesForConditionalExpressionTemplate(
      refChildPath,
      opcodes,
      state,
      (conditionalPath, conditionalOpcodes) => {
        createOpcodesForReactElementHostNodeChild(
          hostNodeId,
          conditionalPath,
          onlyChild,
          conditionalOpcodes,
          state,
          componentPath,
        );
      },
    );
    return;
  }

  if (t.isLogicalExpression(childNode) && assertType(childPath, typeAnnotation, true, state, "REACT_NODE")) {
    markNodeAsDCE(childNode);
    createOpcodesForLogicalExpressionTemplate(
      refChildPath,
      opcodes,
      state,
      componentPath,
      false,
      (conditionalPath, conditionalOpcodes) => {
        createOpcodesForReactElementHostNodeChild(
          hostNodeId,
          conditionalPath,
          onlyChild,
          conditionalOpcodes,
          state,
          componentPath,
        );
      },
    );
    return;
  }

  if (isArrayMapConstructorTemplate(refChildPath, state)) {
    pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILDREN_ARRAY_MAP_TEMPLATE");
    createOpcodesForArrayMapTemplate(refChildPath, opcodes, state, componentPath);
    state.dynamicHostNodesId.add(hostNodeId);
    return;
  }

  if (t.isArrayExpression(childNode)) {
    markNodeAsDCE(childNode);
    const elementsPath = refChildPath.get("elements");
    if (elementsPath.length > 0) {
      if (elementsPath.length === 0) {
        createOpcodesForReactElementHostNodeChild(hostNodeId, elementsPath[0], true, opcodes, state, componentPath);
      } else {
        for (let elementPath of elementsPath) {
          createOpcodesForReactElementHostNodeChild(
            hostNodeId,
            getReferenceFromExpression(elementPath, state),
            false,
            opcodes,
            state,
            componentPath,
          );
        }
      }
    }
    return;
  }
  const childOpcodes = [];

  createOpcodesForNode(childPath, refChildPath, childOpcodes, state, componentPath, false, value => {
    if (t.isStringLiteral(value)) {
      const text = handleWhiteSpace(value.value + "");
      if (text === "") {
        return null;
      }
      return t.stringLiteral(escapeText(text));
    } else if (t.isNumericLiteral(value)) {
      return t.stringLiteral(value);
    } else if (typeof value === "string") {
      const text = handleWhiteSpace(value + "");
      if (text === "") {
        return null;
      }
      return escapeText(text);
    }
    return value;
  });

  // If there are no opcodes then early return.
  if (childOpcodes.length === 0) {
    return;
  }
  if (t.isJSXElement(childNode) || t.isJSXFragment(childNode)) {
    opcodes.push(...childOpcodes);
    return;
  }
  // Empty children
  if (assertType(childPath, typeAnnotation, false, state, "NULL", "VOID", "BOOLEAN")) {
    // TODO remove runtime values to optimize size?
    return;
  }
  if (t.isArrowFunctionExpression(childNode) || t.isFunctionExpression(childNode)) {
    pushOpcode(opcodes, "ELEMENT_DYNAMIC_FUNCTION_CHILD", childOpcodes);
    const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
    pushOpcodeValue(opcodes, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
    return;
  }
  // Partial templates from call expressions
  if (t.isCallExpression(childNode) && isOpcodesTemplateFromFuncCall(childOpcodes)) {
    // We don't want the first opcode, as that is TEMPLATE_FROM_FUNC_CALL
    const [, ...extractedOpcodes] = childOpcodes;
    if (onlyChild) {
      pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILDREN_TEMPLATE_FROM_FUNC_CALL", extractedOpcodes);
    } else {
      pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILD_TEMPLATE_FROM_FUNC_CALL", extractedOpcodes);
    }
    const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
    pushOpcodeValue(opcodes, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
    return;
  }
  // React templates from call expressions within the component
  if (assertType(childPath, typeAnnotation, true, state, "REACT_NODE") && t.isCallExpression(childNode)) {
    opcodes.push(...childOpcodes);
    return;
  }
  // React templates from incoming props
  if (assertType(childPath, typeAnnotation, true, state, "REACT_NODE")) {
    if (state.isRootComponent) {
      throw new Error(
        `The compiler found a React element node type in the root component but was unable to statically find JSX template at ${getCodeLocation(
          childNode,
        )}`,
      );
    }
    const refTemplatePropPointer = getRuntimeValueIndex(refChildPath.node, state);
    if (onlyChild) {
      pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILDREN_REACT_NODE_TEMPLATE", refTemplatePropPointer);
      state.dynamicHostNodesId.add(hostNodeId);
    } else {
      pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILD_REACT_NODE_TEMPLATE", refTemplatePropPointer);
    }
    const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
    pushOpcodeValue(opcodes, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
    return;
  }
  // Static or dynamic value
  if (runtimeValueHash === getRuntimeValueHash(state)) {
    if (onlyChild) {
      pushOpcode(opcodes, "ELEMENT_STATIC_CHILDREN_VALUE", childOpcodes);
    } else {
      pushOpcode(opcodes, "ELEMENT_STATIC_CHILD_VALUE", childOpcodes);
    }
  } else {
    if (onlyChild) {
      pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILDREN_VALUE", childOpcodes);
    } else {
      pushOpcode(opcodes, "ELEMENT_DYNAMIC_CHILD_VALUE", childOpcodes);
    }
    const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
    pushOpcodeValue(opcodes, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
  }
}

export function createOpcodesForJSXFragment(childrenPath, opcodes, state, componentPath) {
  createOpcodesForReactFragment(childrenPath, opcodes, state, componentPath);
}

function createOpcodesForReactCreateElementFragment(args, opcodes, state, componentPath) {
  let children = null;
  markNodeAsDCE(args[0].node);
  if (args.length > 2) {
    children = args.slice(2);
  }
  createOpcodesForReactFragment(children, opcodes, state, componentPath);
}

function createOpcodesForReactFragment(children, opcodes, state, componentPath) {
  pushOpcode(opcodes, "OPEN_FRAGMENT");
  const hostNodeId = Symbol();
  if (children.length > 1) {
    for (let i = 0; i < children.length; i++) {
      createOpcodesForReactElementHostNodeChild(hostNodeId, children[i], false, opcodes, state, componentPath);
    }
  } else if (children.length === 1) {
    createOpcodesForReactElementHostNodeChild(hostNodeId, children[0], false, opcodes, state, componentPath);
  }
  pushOpcode(opcodes, "CLOSE_FRAGMENT");
}

function createOpcodesForHostNodeStylesIdentifier(
  hostNodeId,
  typeAnnotation,
  stylePath,
  stylePathRef,
  opcodes,
  state,
  componentPath,
) {
  pushOpcode(opcodes, "OPEN_PROP_STYLE");
  for (let typeProperty of typeAnnotation.properties) {
    if (!t.isObjectTypeProperty(typeProperty)) {
      invariant(false, "TODO");
    }
    const key = typeProperty.key;
    let styleName;

    if (t.isIdentifier(key)) {
      styleName = key.name;
    } else {
      invariant(false, "TODO");
    }
    const hyphenatedStyleName = hyphenateStyleName(styleName);
    const runtimeValuePointer = getRuntimeValueIndex(t.memberExpression(stylePathRef.node, key), state);

    pushOpcode(opcodes, "DYNAMIC_PROP_STYLE", hyphenatedStyleName);
    pushOpcodeValue(opcodes, runtimeValuePointer);
  }
  pushOpcode(opcodes, "CLOSE_PROP_STYLE");
}

function createOpcodesForHostNodeStylesObject(hostNodeId, stylePath, stylePathRef, opcodes, state, componentPath) {
  const propertiesPath = stylePathRef.get("properties");

  pushOpcode(opcodes, "OPEN_PROP_STYLE");
  for (let propertyPath of propertiesPath) {
    const propertyOpcodes = [];
    const node = propertyPath.node;

    if (!t.isObjectProperty(node)) {
      invariant(false, "TODO");
    }
    const key = node.key;
    let styleName;

    if (t.isIdentifier(key)) {
      styleName = key.name;
    } else if (t.isStringLiteral(key)) {
      styleName = key.value;
    } else {
      invariant(false, "TODO");
    }
    const propertyValue = propertyPath.get("value");
    const propertyValueRef = getReferenceFromExpression(propertyValue, state);
    const runtimeValueHash = getRuntimeValueHash(state);

    createOpcodesForNode(propertyValue, propertyValueRef, propertyOpcodes, state, componentPath, false, value => {
      if (t.isStringLiteral(value) || t.isNumericLiteral(value) || t.isBooleanLiteral(value)) {
        const isCustomProperty = styleName.indexOf("--") === 0;
        const styleValue = dangerousStyleValue(styleName.value, value.value, isCustomProperty);

        return t.stringLiteral(styleValue);
      } else if (t.isNullLiteral(value) || (t.isUnaryExpression(value) && value.operator === "void")) {
        return value;
      } else {
        return dangerousStyleValue(styleName, value, false);
      }
    });
    const hyphenatedStyleName = hyphenateStyleName(styleName);

    // Static vs Dynamic style
    if (isUnitlessNumber.has(styleName)) {
      if (runtimeValueHash === getRuntimeValueHash(state)) {
        pushOpcode(opcodes, "STATIC_PROP_UNITLESS_STYLE", [hyphenatedStyleName, ...propertyOpcodes]);
      } else {
        pushOpcode(opcodes, "DYNAMIC_PROP_UNITLESS_STYLE", [hyphenatedStyleName, ...propertyOpcodes]);
      }
    } else {
      if (runtimeValueHash === getRuntimeValueHash(state)) {
        pushOpcode(opcodes, "STATIC_PROP_STYLE", [hyphenatedStyleName, ...propertyOpcodes]);
      } else {
        pushOpcode(opcodes, "DYNAMIC_PROP_STYLE", [hyphenatedStyleName, ...propertyOpcodes]);
      }
    }
  }
  pushOpcode(opcodes, "CLOSE_PROP_STYLE");
}

function canInlineNode(path, state) {
  const pathRef = getReferenceFromExpression(path, state);

  if (isPrimitive(pathRef.node) || t.isJSXElement(pathRef.node)) {
    return true;
  } else if (t.isArrayExpression(pathRef.node)) {
    const elements = path.get("elements");

    for (let element of elements) {
      const canInlineElement = canInlineNode(element, state);

      if (!canInlineElement) {
        return false;
      }
    }
    return true;
  } else if (t.isObjectExpression(pathRef.node)) {
    const properties = path.get("properties");

    for (let property of properties) {
      if (t.isObjectProperty(property)) {
        if (property.computed) {
          const propertyKey = property.get("key");
          if (!t.isStringLiteral(propertyKey)) {
            return false;
          }
        }
        const propertyValue = property.get("value");
        const canInlineProperty = canInlineNode(propertyValue, state);

        if (!canInlineProperty) {
          return false;
        }
      } else {
        invariant(false, "TODO");
      }
    }
    return true;
  }
  return false;
}

function getTopLevelPathFromComponentPath(path) {
  let parentPath = path.parentPath;
  let lastPathKey = path.key;

  while (!t.isProgram(parentPath.node) && !t.isBlockStatement(parentPath.node)) {
    lastPathKey = parentPath.key;
    parentPath = parentPath.parentPath;
  }
  return { key: lastPathKey, path: parentPath };
}

function hoistOpcodesNode(componentPath, state, opcodesNode) {
  const hash = JSON.stringify(opcodesNode);
  const propTemplateOpcodeCache = state.propTemplateOpcodeCache;

  if (propTemplateOpcodeCache.has(hash)) {
    return propTemplateOpcodeCache.get(hash);
  }
  const identifier = t.identifier("__hoisted__opcodes__" + state.counters.hoistedOpcodes++);
  markNodeAsUsed(identifier);
  let hoistDepth = 0;
  let currentPath = componentPath;

  while (hoistDepth++ < 3) {
    let { key, path } = getTopLevelPathFromComponentPath(currentPath);
    if (t.isProgram(path.node)) {
      const body = path.node.body;
      body.splice(key, 0, t.variableDeclaration("var", [t.variableDeclarator(identifier, opcodesNode)]));
      break;
    } else {
      currentPath = path;
      if (hoistDepth > 1) {
        invariant(false, "TODO");
      }
    }
  }

  propTemplateOpcodeCache.set(hash, identifier);
  return identifier;
}

function createPropTemplateFromJSXElement(path, state, componentPath) {
  const opcodes = [];
  const runtimeValues = new Map();
  const childState = { ...state, ...{ runtimeValues } };

  createOpcodesForJSXElement(path, opcodes, childState, componentPath);

  const hoistedOpcodes = hoistOpcodesNode(componentPath, state, normalizeOpcodes(opcodes));

  state.helpers.add("createReactNode");
  if (runtimeValues.size === 0) {
    return [t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes]), true];
  } else {
    const runtimeValuesArray = [];
    for (let [runtimeValue, { index }] of runtimeValues) {
      runtimeValuesArray[index] = runtimeValue;
    }
    return [
      t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes, t.arrayExpression(runtimeValuesArray)]),
      false,
    ];
  }
}

function createPropTemplateFromReactCreateElement(path, state, componentPath) {
  const opcodes = [];
  const runtimeValues = new Map();
  const childState = { ...state, ...{ runtimeValues } };

  createOpcodesForReactCreateElement(path, opcodes, childState, componentPath);

  const hoistedOpcodes = hoistOpcodesNode(componentPath, state, normalizeOpcodes(opcodes));

  state.helpers.add("createReactNode");
  if (runtimeValues.size === 0) {
    return [t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes]), true];
  } else {
    const runtimeValuesArray = [];
    for (let [runtimeValue, { index }] of runtimeValues) {
      runtimeValuesArray[index] = runtimeValue;
    }
    return [
      t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes, t.arrayExpression(runtimeValuesArray)]),
      false,
    ];
  }
}

function createPropTemplateForMutatedBinding(pathRef, state, componentPath) {
  const { paths, binding } = getAllPathsFromMutatedBinding(pathRef, state);
  if (paths.length === 0) {
    return null;
  }

  let baseConditionalNode = null;
  let currentConditonalNode = null;
  for (let { pathConditions, path: conditionalPath } of paths) {
    const joinedPathConditionsNode = joinPathConditions(pathConditions, state);
    const { node } = getNodeAndInlineStatusFromValuePath(conditionalPath, state, componentPath);
    if (baseConditionalNode === null) {
      currentConditonalNode = baseConditionalNode = t.conditionalExpression(
        joinedPathConditionsNode,
        node,
        emptyPlaceholderNode,
      );
    } else {
      currentConditonalNode = currentConditonalNode.alternate = t.conditionalExpression(
        joinedPathConditionsNode,
        node,
        emptyPlaceholderNode,
      );
    }
  }
  const node = binding.path.node;
  if (t.isVariableDeclarator(node)) {
    if (node.init !== null) {
      const elsePath = binding.path.get("init");
      const { node: elseNode } = getNodeAndInlineStatusFromValuePath(elsePath, state, componentPath);
      currentConditonalNode.alternate = elseNode;
    }
  } else {
    invariant(false, "TODO");
  }
  return { node: baseConditionalNode, canInline: false };
}

function createPropTemplateForConditionalExpression(pathRef, state, componentPath) {
  const testPath = getReferenceFromExpression(pathRef.get("test"), state);
  const test = testPath.node;
  const consequentPath = pathRef.get("consequent");
  const { node: consequentNode } = getNodeAndInlineStatusFromValuePath(consequentPath, state, componentPath);
  const alternatePath = pathRef.get("alternate");
  const { node: alternateNode } = getNodeAndInlineStatusFromValuePath(alternatePath, state, componentPath);
  const conditionalNode = t.conditionalExpression(test, consequentNode, alternateNode);
  return { node: conditionalNode, canInline: false };
}

function createPropTemplateForLogicalExpression(pathRef, state, componentPath) {
  const leftPath = pathRef.get("left");
  const { node: leftNode } = getNodeAndInlineStatusFromValuePath(leftPath, state, componentPath);
  const rightPath = pathRef.get("alternate");
  const { node: rightNode } = getNodeAndInlineStatusFromValuePath(rightPath, state, componentPath);
  const conditionalNode = t.logicalExpression(leftNode, rightNode);
  return { node: conditionalNode, canInline: false };
}

function createPropTemplateForObjectExpression(pathRef, state, componentPath) {
  const propertyNodes = [];
  let canInlineElements = true;

  const propertiesPath = pathRef.get("properties");
  if (propertiesPath.length > 0) {
    for (let propertyPath of propertiesPath) {
      const propertyNode = propertyPath.node;

      if (t.isObjectProperty(propertyNode)) {
        const keyNode = propertyNode.key;
        const computed = propertyNode.computed;
        const shorthand = propertyNode.shorthand;
        const valuePath = getReferenceFromExpression(propertyPath.get("value"), state);
        const { node, canInline } = getNodeAndInlineStatusFromValuePath(valuePath, state, componentPath);
        if (!canInline) {
          canInlineElements = false;
        }
        propertyNodes.push(t.objectProperty(keyNode, node, computed, shorthand));
      } else {
        invariant(false, "TODO");
      }
    }
  }
  return { node: t.objectExpression(propertyNodes), canInline: canInlineElements };
}

function createPropTemplateForArrayExpression(pathRef, state, componentPath) {
  const childrenNodes = [];
  let canInlineElements = true;

  const elementsPath = pathRef.get("elements");
  if (elementsPath.length > 0) {
    for (let elementPath of elementsPath) {
      const { node, canInline } = getNodeAndInlineStatusFromValuePath(elementPath, state, componentPath);
      if (!canInline) {
        canInlineElements = false;
      }
      childrenNodes.push(node);
    }
  }
  return { node: t.arrayExpression(childrenNodes), canInline: canInlineElements };
}

function createPropTemplateForCallExpression(path, pathRef, state, componentPath) {
  const calleePath = getReferenceFromExpression(pathRef.get("callee"), state);
  const { isStatic, templateOpcodes } = createOpcodesForReactComputeFunction(calleePath, state, false, null, null);
  const hoistedOpcodes = hoistOpcodesNode(componentPath, state, normalizeOpcodes(templateOpcodes));

  state.helpers.add("createReactNode");
  if (isStatic) {
    const node = t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes]);
    return { node, canInline: true };
  }
  const node = t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes, pathRef.node]);
  return { node, canInline: true };
}

function createPropTemplateForFunctionExpression(pathRef, state, componentPath) {
  const node = pathRef.node;

  if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
    if (isNodeWithinReactElementTemplate(pathRef, state)) {
      moveOutFunctionFromTemplate(pathRef);
    }
  }
  const { isStatic, templateOpcodes } = createOpcodesForReactComputeFunction(pathRef, state, false, null, null);
  const hoistedOpcodes = hoistOpcodesNode(componentPath, state, normalizeOpcodes(templateOpcodes));

  state.helpers.add("createReactNode");
  if (isStatic) {
    const funcNode = t.arrowFunctionExpression([], t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes]));
    return { node: funcNode, canInline: true };
  } else {
    const params = pathRef.node.params;
    validateParamsDoNotConflictOuterScope(params, componentPath, pathRef, state);
    pathRef.node.params = [];
    const funcNode = t.arrowFunctionExpression(
      params,
      t.callExpression(t.identifier("createReactNode"), [hoistedOpcodes, t.callExpression(pathRef.node, [])]),
    );
    return { node: funcNode, canInline: false };
  }
}

function createPropForCallExpression(path, pathRef, state, componentPath) {
  // Check if any of the nodes passed as arguments contain template nodes
  validateArgumentsDoNotContainTemplateNodes(path, pathRef, state);

  if (isNodeWithinReactElementTemplate(path, state)) {
    moveOutCallExpressionFromTemplate(path, pathRef, state);
  }

  if (assertType(path, getTypeAnnotationForExpression(pathRef, state), true, state, "REACT_NODE")) {
    return createPropTemplateForCallExpression(path, pathRef, state, componentPath);
  }
  let canInline = canInlineNode(pathRef, state);
  let node = pathRef.node;
  if (!canInline) {
    markNodeAsUsed(node);
  }
  return { node, canInline };
}

function getNodeAndInlineStatusFromValuePath(path, state, componentPath) {
  const pathRef = getReferenceFromExpression(path, state);
  const typeAnnotation = getTypeAnnotationForExpression(pathRef, state);

  if (
    t.isIdentifier(pathRef.node) &&
    !isIdentifierReferenceConstant(pathRef, state) &&
    assertType(path, typeAnnotation, true, state, "REACT_NODE")
  ) {
    const resultOrNull = createPropTemplateForMutatedBinding(pathRef, state, componentPath);
    if (resultOrNull !== null) {
      return resultOrNull;
    }
  }
  let canInline = canInlineNode(pathRef, state);
  let node = pathRef.node;

  if (t.isConditionalExpression(node) && pathContainsReactElement(pathRef, state)) {
    return createPropTemplateForConditionalExpression(pathRef, state, componentPath);
  } else if (t.isLogicalExpression(node) && pathContainsReactElement(pathRef, state)) {
    return createPropTemplateForLogicalExpression(pathRef, state, componentPath);
  } else if (t.isArrayExpression(node) && pathContainsReactElement(pathRef, state)) {
    return createPropTemplateForArrayExpression(pathRef, state, componentPath);
  } else if (t.isObjectExpression(node) && pathContainsReactElement(pathRef, state)) {
    return createPropTemplateForObjectExpression(pathRef, state, componentPath);
  } else if (t.isJSXText(node)) {
    node = t.stringLiteral(handleWhiteSpace(node.value));
  } else if (t.isJSXElement(node)) {
    [node, canInline] = createPropTemplateFromJSXElement(pathRef, state, componentPath);
  } else if (isReactCreateElement(pathRef, state)) {
    [node, canInline] = createPropTemplateFromReactCreateElement(pathRef, state, componentPath);
  } else if (t.isCallExpression(node)) {
    return createPropForCallExpression(path, pathRef, state, componentPath);
  } else if (assertType(path, typeAnnotation, true, state, "REACT_NODE")) {
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node) || t.isFunctionDeclaration(node)) {
      return createPropTemplateForFunctionExpression(pathRef, state, componentPath);
    }
    if (state.isRootComponent || (!t.isIdentifier(node) && !t.isMemberExpression(node))) {
      throw new Error(
        `The compiler found a React element type used as props in component <${getComponentName(
          componentPath,
        )}> but was unable to statically find JSX template at ${getCodeLocation(pathRef.node)}`,
      );
    }
  }

  if (!canInline) {
    markNodeAsUsed(node);
  }
  return { node, canInline };
}

function getPropNodeForCompositeComponent(propName, attributesPath, childrenPath, defaultProps, state, componentPath) {
  let defaultPropValue = null;
  if (defaultProps !== null) {
    const defaultPropsProperties = defaultProps.get("properties");
    for (let defaultPropsProperty of defaultPropsProperties) {
      if (t.isObjectProperty(defaultPropsProperty.node)) {
        const nameNode = defaultPropsProperty.node.key;
        let attributeName;

        if (t.isIdentifier(nameNode)) {
          attributeName = nameNode.name;
        }
        if (propName === attributeName) {
          const valuePath = defaultPropsProperty.get("value");
          defaultPropValue = getNodeAndInlineStatusFromValuePath(valuePath, state, componentPath);
          break;
        }
      } else {
        invariant(false, "TODO");
      }
    }
  }
  if (propName === "children" && childrenPath !== null) {
    const filteredChildrenPath = childrenPath.filter(childPath => {
      if (t.isJSXText(childPath.node) && handleWhiteSpace(childPath.node.value) === "") {
        return false;
      }
      return true;
    });
    if (filteredChildrenPath.length === 0) {
      return { node: t.unaryExpression("void", t.numericLiteral(0)), canInline: true };
    } else if (filteredChildrenPath.length === 1) {
      return getNodeAndInlineStatusFromValuePath(filteredChildrenPath[0], state, componentPath);
    } else {
      const childrenNodes = [];
      let canInlineChildren = true;

      for (let childPath of filteredChildrenPath) {
        const { node, canInline } = getNodeAndInlineStatusFromValuePath(childPath, state, componentPath);
        if (!canInline) {
          canInlineChildren = false;
        }
        childrenNodes.push(node);
      }
      return { node: t.arrayExpression(childrenNodes), canInline: canInlineChildren };
    }
  }
  let result = null;
  if (Array.isArray(attributesPath)) {
    for (let attributePath of attributesPath) {
      if (t.isJSXAttribute(attributePath.node)) {
        const nameNode = attributePath.node.name;
        let attributeName;

        if (t.isJSXIdentifier(nameNode)) {
          attributeName = nameNode.name;
        }
        if (propName === attributeName) {
          const valuePath = attributePath.get("value");
          markNodeAsDCE(valuePath.node);
          result = getNodeAndInlineStatusFromValuePath(valuePath, state, componentPath);
        }
      } else if (t.isJSXSpreadAttribute(attributePath.node) && t.isIdentifier(attributePath.node.argument)) {
        const argumentPath = attributePath.get("argument");
        const argumentPathRef = getReferenceFromExpression(argumentPath, state);

        if (t.isObjectExpression(argumentPathRef.node)) {
          const propertiesPath = argumentPathRef.get("properties");

          for (let propertyPath of propertiesPath) {
            if (t.isObjectProperty(propertyPath.node)) {
              const key = propertyPath.node.key;
              const valuePath = propertyPath.get("value");
              if (t.isIdentifier(key) && key.name === propName) {
                markNodeAsDCE(valuePath.node);
                result = getNodeAndInlineStatusFromValuePath(valuePath, state, componentPath);
                break;
              }
            } else {
              invariant(false, "TODO");
            }
          }
        } else {
          invariant(false, "TODO");
        }
      } else if (t.isObjectProperty(attributePath.node)) {
        const nameNode = attributePath.node.key;
        let attributeName;

        if (t.isIdentifier(nameNode)) {
          attributeName = nameNode.name;
        } else if (t.isStringLiteral(nameNode)) {
          attributeName = nameNode.value;
        }
        if (propName === attributeName) {
          const valuePath = attributePath.get("value");
          markNodeAsDCE(valuePath.node);
          result = getNodeAndInlineStatusFromValuePath(valuePath, state, componentPath);
        }
      } else {
        invariant(false, "TODO");
      }
    }
  } else if (t.isCallExpression(attributesPath)) {
    if (isObjectAssignCall(attributesPath, state)) {
      const args = attributesPath.get("arguments");

      for (let argumentPath of args) {
        const argumentPathRef = getReferenceFromExpression(argumentPath, state);

        if (t.isObjectExpression(argumentPathRef.node)) {
          const propertiesPath = argumentPathRef.get("properties");

          for (let propertyPath of propertiesPath) {
            if (t.isObjectProperty(propertyPath.node)) {
              const key = propertyPath.node.key;
              const valuePath = propertyPath.get("value");
              if (
                (t.isIdentifier(key) && key.name === propName) ||
                (t.isStringLiteral(key) && key.value === propName)
              ) {
                markNodeAsDCE(valuePath.node);
                result = getNodeAndInlineStatusFromValuePath(valuePath, state, componentPath);
                break;
              }
            } else {
              invariant(false, "TODO");
            }
          }
        } else if (t.isCallExpression(argumentPathRef.node)) {
          const annotation = getTypeAnnotationForExpression(argumentPathRef, state);

          if (t.isObjectTypeAnnotation(annotation)) {
            for (let typeProperty of annotation.properties) {
              const typePropertyKey = typeProperty.key;

              if (t.isIdentifier(typePropertyKey) && propName === typePropertyKey.name) {
                const cachedNode = getCachedRuntimeValue(argumentPathRef.node, state);
                result = { node: t.memberExpression(cachedNode, typePropertyKey), canInline: false };
              } else if (t.isStringLiteral(typePropertyKey) && propName === typePropertyKey.value) {
                const cachedNode = getCachedRuntimeValue(argumentPathRef.node, state);
                result = { node: t.memberExpression(cachedNode, typePropertyKey, true), canInline: false };
              }
            }
          } else {
            invariant(false, "TODO");
          }
        } else {
          invariant(false, "TODO");
        }
      }
    } else {
      invariant(false, "TODO");
    }
  }
  if (result !== null) {
    return result;
  }
  if (defaultPropValue !== null) {
    return defaultPropValue;
  }
  return { node: t.unaryExpression("void", t.numericLiteral(0)), canInline: true };
}

function createPropsArrayForCompositeComponent(
  path,
  attributesPath,
  childrenPath,
  shapeOfPropsObject,
  defaultProps,
  state,
  componentPath,
) {
  let canInlineArray = true;
  const propsArray = [];

  for (let propShape of shapeOfPropsObject) {
    const propName = propShape.key;
    const { node, canInline } = getPropNodeForCompositeComponent(
      propName,
      attributesPath,
      childrenPath,
      defaultProps,
      state,
      componentPath,
    );
    if (!canInline) {
      canInlineArray = false;
    }
    propsArray.push(node);
  }

  return {
    canInlineArray,
    propsArray,
  };
}

function createOpcodesForCompositeComponent(
  path,
  componentName,
  attributesPath,
  childrenPath,
  opcodes,
  state,
  componentPath,
) {
  const binding = getBindingPathRef(path, componentName, state);
  const compiledComponentCache = state.compiledComponentCache;
  let result;
  let externalModuleState;

  // Change the require call to be that of the compiled
  if (state.externalBindings.has(componentName)) {
    const { pathRef, resolvedPathRef } = state.externalBindings.get(componentName);
    if (isCommonJsLikeRequireCall(pathRef)) {
      state.applyPostTransform(() => {
        updateCommonJSLikeRequireCallPathToCompiledPath(pathRef);
      });
    } else if (t.isImportDefaultSpecifier(pathRef.node) || t.isImportSpecifier(pathRef.node)) {
      state.applyPostTransform(() => {
        updateImportSyntaxPathToCompiledPath(pathRef.parentPath);
      });
    }
    externalModuleState = resolvedPathRef.moduleState;
    externalModuleState.needsCompiling();
    externalModuleState.isRootComponent = false;
  }
  if (compiledComponentCache.has(componentName)) {
    result = compiledComponentCache.get(componentName);
  } else {
    if (binding === undefined) {
      throw new Error(
        `Compiled failed to find the reference for component <${componentName}> at ${getCodeLocation(path.node)}`,
      );
    }
    let compositeComponentPath = getReferenceFromExpression(binding.path, state, true, componentName);
    if (isDestructuredRef(compositeComponentPath)) {
      const propertyPath = compositeComponentPath.property;

      if (t.isObjectProperty(propertyPath.node)) {
        const valuePath = propertyPath.get("value");
        compositeComponentPath = getReferenceFromExpression(valuePath, state);
      } else {
        compositeComponentPath = propertyPath;
      }
    }
    const childState = externalModuleState || {
      ...state,
      ...{ isRootComponent: false },
      ...{ reconciler: { valueIndex: 0 } },
    };
    result = createOpcodesForReactFunctionComponent(compositeComponentPath, childState);
  }
  const { defaultProps, isStatic, shapeOfPropsObject } = result;

  const componentNameIdentifier = t.identifier(componentName);
  markNodeAsUsed(componentNameIdentifier);
  pushOpcode(opcodes, "REF_COMPONENT", componentNameIdentifier);
  if (isStatic) {
    if (Array.isArray(attributesPath)) {
      for (let attributePath of attributesPath) {
        markNodeAsDCE(attributePath.node);
      }
    }
    if (Array.isArray(childrenPath)) {
      for (let childPath of childrenPath) {
        markNodeAsDCE(childPath.node);
      }
    }
    pushOpcodeValue(opcodes, t.nullLiteral(), "COMPONENT_PROPS_ARRAY");
  } else {
    const { propsArray, canInlineArray } = createPropsArrayForCompositeComponent(
      path,
      attributesPath,
      childrenPath,
      shapeOfPropsObject,
      defaultProps,
      state,
      componentPath,
    );
    if (canInlineArray) {
      pushOpcodeValue(opcodes, t.arrayExpression(propsArray), "COMPONENT_PROPS_ARRAY");
    } else {
      const propsArrayValuePointer = getRuntimeValueIndexForPropsArray(propsArray, state);
      pushOpcodeValue(opcodes, propsArrayValuePointer, "COMPONENT_PROPS_ARRAY");
    }
  }
}

export function createOpcodesForJSXElement(path, opcodes, state, componentPath) {
  const openingElementPath = path.get("openingElement");
  const typePath = openingElementPath.get("name");
  const attributesPath = openingElementPath.get("attributes");
  const childrenPath = path.get("children");

  createOpcodesForJSXElementType(typePath, attributesPath, childrenPath, opcodes, state, componentPath);

  if (t.isBlockStatement(path.node)) {
    const body = path.get("body");
    const returnStatement = body[body.length - 1];
    if (t.isReturnStatement(returnStatement)) {
      returnStatement.get("argument").replaceWith(emptyObject);
    } else {
      invariant(false, "Should never happen");
    }
  } else {
    path.replaceWith(emptyObject);
  }
}

function createOpcodesForJSXElementType(typePath, attributesPath, childrenPath, opcodes, state, componentPath) {
  const typeName = t.isStringLiteral(typePath.node) ? typePath.node.value : typePath.node.name;

  if (isReferenceReactContextProvider(typePath, state)) {
    const contextObjectRuntimeValueIndex = getContextObjectRuntimeValueIndex(typePath, state);
    const hostNodeId = Symbol();
    pushOpcode(opcodes, "OPEN_CONTEXT_PROVIDER", contextObjectRuntimeValueIndex);
    createOpcodesForJSXElementHostComponent(
      hostNodeId,
      null,
      attributesPath,
      childrenPath,
      opcodes,
      state,
      componentPath,
    );
    pushOpcode(opcodes, "CLOSE_CONTEXT_PROVIDER");
  } else if (isReferenceReactContextConsumer(typePath, state)) {
    createOpcodesForReactContextConsumer(typePath, childrenPath, opcodes, state, componentPath);
  } else if (isReactFragment(typePath, state)) {
    createOpcodesForJSXFragment(childrenPath, opcodes, state, componentPath);
  } else if (isHostComponentType(typePath, state)) {
    const isVoidElement = voidElements.has(typeName);
    const elementOpcodes = [];
    const hostNodeId = Symbol();
    createOpcodesForJSXElementHostComponent(
      hostNodeId,
      typeName,
      attributesPath,
      childrenPath,
      elementOpcodes,
      state,
      componentPath,
    );
    if (state.dynamicHostNodesId.has(hostNodeId)) {
      if (typeName === "div") {
        pushOpcode(opcodes, "OPEN_ELEMENT_DIV_WITH_POINTER");
      } else if (typeName === "span") {
        pushOpcode(opcodes, "OPEN_ELEMENT_SPAN_WITH_POINTER");
      } else if (isVoidElement) {
        pushOpcode(opcodes, "OPEN_VOID_ELEMENT_WITH_POINTER", typeName);
      } else {
        pushOpcode(opcodes, "OPEN_ELEMENT_WITH_POINTER", typeName);
      }
      const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
      pushOpcodeValue(opcodes, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
    } else {
      if (typeName === "div") {
        pushOpcode(opcodes, "OPEN_ELEMENT_DIV");
      } else if (typeName === "span") {
        pushOpcode(opcodes, "OPEN_ELEMENT_SPAN");
      } else if (isVoidElement) {
        pushOpcode(opcodes, "OPEN_VOID_ELEMENT", typeName);
      } else {
        pushOpcode(opcodes, "OPEN_ELEMENT", typeName);
      }
    }
    opcodes.push(...elementOpcodes);
    if (isVoidElement) {
      pushOpcode(opcodes, "CLOSE_VOID_ELEMENT");
    } else {
      pushOpcode(opcodes, "CLOSE_ELEMENT");
    }
  } else if (isConditionalComponentType(typePath, state)) {
    const typePathRef = getReferenceFromExpression(typePath, state);
    if (t.isConditionalExpression(typePathRef.node)) {
      createOpcodesForConditionalExpressionTemplate(
        typePathRef,
        opcodes,
        state,
        (conditionalPath, conditionalOpcodes) => {
          createOpcodesForJSXElementType(
            conditionalPath,
            attributesPath,
            childrenPath,
            conditionalOpcodes,
            state,
            componentPath,
          );
        },
      );
      return;
    }
    invariant(false, "TODO");
  } else {
    let componentName = typeName;

    if (typeName === undefined) {
      if (t.isFunctionDeclaration(typePath.node)) {
        componentName = typePath.node.id.name;
      } else {
        invariant(false, "TODO");
      }
    }
    createOpcodesForCompositeComponent(
      typePath,
      componentName,
      attributesPath,
      childrenPath,
      opcodes,
      state,
      componentPath,
    );
  }
}

function getPropsMapFromJSXElementAttributes(attributesPath, state) {
  const propsMap = new Map();
  for (let attributePath of attributesPath) {
    const attributeNode = attributePath.node;
    if (t.isJSXAttribute(attributeNode)) {
      const attributeName = attributeNode.name;
      let nameStr;

      if (t.isJSXIdentifier(attributeName)) {
        nameStr = attributeName.name;
      } else {
        invariant(false, "TODO");
      }
      const valuePath = attributePath.get("value");
      propsMap.set(nameStr, valuePath);
    } else if (t.isJSXSpreadAttribute(attributeNode) && t.isIdentifier(attributeNode.argument)) {
      const argumentPath = attributePath.get("argument");
      const argumentPathRef = getReferenceFromExpression(argumentPath, state, true);

      if (t.isObjectExpression(argumentPathRef.node)) {
        const properties = argumentPathRef.get("properties");
        for (let propertyPath of properties) {
          if (t.isObjectProperty(propertyPath.node)) {
            let nameStr;

            if (t.isIdentifier(propertyPath.node.key)) {
              nameStr = propertyPath.node.key.name;
            } else {
              invariant(false, "TOOD");
            }
            const valuePath = propertyPath.get("value");
            propsMap.set(nameStr, valuePath);
          } else {
            invariant(false, "TOOD");
          }
        }
      } else {
        invariant(false, "TOOD");
      }
    } else {
      invariant(false, "TOOD");
    }
  }
  return propsMap;
}

function getPropsMapFromObjectExpression(propertiesPath) {
  const propsMap = new Map();
  for (let propertyPath of propertiesPath) {
    const propertyNode = propertyPath.node;
    if (t.isObjectProperty(propertyNode)) {
      const attributeName = propertyNode.key;
      let nameStr;

      if (t.isIdentifier(attributeName)) {
        nameStr = attributeName.name;
      } else if (t.isStringLiteral(attributeName)) {
        nameStr = attributeName.value;
      } else {
        invariant(false, "TODO");
      }

      const valuePath = propertyPath.get("value");
      propsMap.set(nameStr, valuePath);
    } else {
      invariant(false, "TODO");
    }
  }
  return propsMap;
}

function createOpcodesForJSXElementHostComponent(
  hostNodeId,
  tagName,
  attributesPath,
  childrenPath,
  opcodes,
  state,
  componentPath,
) {
  // The following is only for host components (<div />) and
  // context provider components (as we treat them like host components).
  // The following logic is not for composite components (<Component />).

  if (attributesPath.length > 0) {
    const propsMap = getPropsMapFromJSXElementAttributes(attributesPath, state);

    if (tagName === "input") {
      if (propsMap.has("type")) {
        createOpcodesForReactElementHostNodePropValue(
          hostNodeId,
          tagName,
          propsMap.get("type"),
          "type",
          opcodes,
          state,
          componentPath,
        );
      }
      // This is all to conform the ReactDOM ordering of props :(
      propsMap.delete("type");
      const value = propsMap.get("value");
      const checked = propsMap.get("checked");
      if (value !== undefined) {
        propsMap.delete("value");
        propsMap.set("value", value);
      }
      if (checked !== undefined) {
        propsMap.delete("checked");
        propsMap.set("checked", checked);
      }
    }
    const renderChildren = propsMap.get("children");
    propsMap.delete("children");
    for (let [propName, valuePath] of propsMap) {
      createOpcodesForReactElementHostNodePropValue(
        hostNodeId,
        tagName,
        valuePath,
        propName,
        opcodes,
        state,
        componentPath,
      );
    }
    if (renderChildren !== undefined) {
      createOpcodesForReactElementHostNodeChild(hostNodeId, renderChildren, true, opcodes, state, componentPath);
    }
  }
  const filteredChildrenPath = childrenPath.filter(childPath => {
    if (t.isJSXText(childPath.node) && handleWhiteSpace(childPath.node.value) === "") {
      return false;
    }
    return true;
  });
  if (filteredChildrenPath.length > 1) {
    for (let i = 0; i < filteredChildrenPath.length; i++) {
      createOpcodesForReactElementHostNodeChild(
        hostNodeId,
        filteredChildrenPath[i],
        false,
        opcodes,
        state,
        componentPath,
      );
    }
  } else if (filteredChildrenPath.length === 1) {
    createOpcodesForReactElementHostNodeChild(hostNodeId, filteredChildrenPath[0], true, opcodes, state, componentPath);
  }
}

function createOpcodesForReactCreateElementHostComponent(hostNodeId, tagName, args, opcodes, state, componentPath) {
  if (args.length > 1) {
    const configPath = args[1];
    const configPathRef = getReferenceFromExpression(configPath, state);
    const configNode = configPathRef.node;

    const createOpcodesGivenPropsMap = propsMap => {
      if (tagName === "input") {
        if (propsMap.has("type")) {
          createOpcodesForReactElementHostNodePropValue(
            hostNodeId,
            tagName,
            propsMap.get("type"),
            "type",
            opcodes,
            state,
            componentPath,
          );
        }
        // This is all to conform the ReactDOM ordering of props :(
        propsMap.delete("type");
        const value = propsMap.get("value");
        const checked = propsMap.get("checked");
        if (value !== undefined) {
          propsMap.delete("value");
          propsMap.set("value", value);
        }
        if (checked !== undefined) {
          propsMap.delete("checked");
          propsMap.set("checked", checked);
        }
      }
      const renderChildren = propsMap.get("children");
      propsMap.delete("children");
      for (let [propName, valuePath] of propsMap) {
        createOpcodesForReactElementHostNodePropValue(
          hostNodeId,
          tagName,
          valuePath,
          propName,
          opcodes,
          state,
          componentPath,
        );
      }
      if (renderChildren !== undefined) {
        createOpcodesForReactElementHostNodeChild(hostNodeId, renderChildren, true, opcodes, state, componentPath);
      }
    };

    if (t.isNullLiteral(configNode)) {
      // NO-OP
    } else if (t.isObjectExpression(configNode)) {
      const propertiesPath = configPathRef.get("properties");
      const propsMap = getPropsMapFromObjectExpression(propertiesPath);

      createOpcodesGivenPropsMap(propsMap);
    } else if (t.isCallExpression(configNode)) {
      if (isObjectAssignCall(configPathRef, state)) {
        const objectAssignArgs = configPathRef.get("arguments");
        let propsMap = new Map();

        for (let argumentPath of objectAssignArgs) {
          const argumentPathRef = getReferenceFromExpression(argumentPath, state);

          if (t.isObjectExpression(argumentPathRef.node)) {
            const propertiesPath = argumentPathRef.get("properties");
            propsMap = new Map([...propsMap, ...getPropsMapFromObjectExpression(propertiesPath)]);
          } else {
            invariant(false, "TODO");
          }
        }
        createOpcodesGivenPropsMap(propsMap);
      } else {
        invariant(false, "TODO");
      }
    } else {
      invariant(false, "TODO");
    }
  }
  if (args.length > 2) {
    const childrenLength = args.length - 2;

    if (childrenLength > 1) {
      for (let i = 0; i < childrenLength; ++i) {
        createOpcodesForReactElementHostNodeChild(hostNodeId, args[2 + i], false, opcodes, state, componentPath);
      }
    } else {
      createOpcodesForReactElementHostNodeChild(hostNodeId, args[2], true, opcodes, state, componentPath);
    }
  }
}

function createOpcodesForReactCreateElementType(typePath, args, opcodes, state, componentPath) {
  if (isHostComponentType(typePath, state)) {
    const nameNode = typePath.node;
    const strName = nameNode.value;
    const isVoidElement = voidElements.has(strName);
    const elementOpcodes = [];
    const hostNodeId = Symbol();
    createOpcodesForReactCreateElementHostComponent(hostNodeId, strName, args, elementOpcodes, state, componentPath);
    if (state.dynamicHostNodesId.has(hostNodeId)) {
      if (strName === "div") {
        pushOpcode(opcodes, "OPEN_ELEMENT_DIV_WITH_POINTER");
      } else if (strName === "span") {
        pushOpcode(opcodes, "OPEN_ELEMENT_SPAN_WITH_POINTER");
      } else if (isVoidElement) {
        pushOpcode(opcodes, "OPEN_VOID_ELEMENT_WITH_POINTER", strName);
      } else {
        pushOpcode(opcodes, "OPEN_ELEMENT_WITH_POINTER", strName);
      }
      const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
      pushOpcodeValue(opcodes, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
    } else {
      if (strName === "div") {
        pushOpcode(opcodes, "OPEN_ELEMENT_DIV");
      } else if (strName === "span") {
        pushOpcode(opcodes, "OPEN_ELEMENT_SPAN");
      } else if (isVoidElement) {
        pushOpcode(opcodes, "OPEN_VOID_ELEMENT", strName);
      } else {
        pushOpcode(opcodes, "OPEN_ELEMENT", strName);
      }
    }
    opcodes.push(...elementOpcodes);
    if (isVoidElement) {
      pushOpcode(opcodes, "CLOSE_VOID_ELEMENT");
    } else {
      pushOpcode(opcodes, "CLOSE_ELEMENT");
    }
  } else if (isConditionalComponentType(typePath, state)) {
    const typePathRef = getReferenceFromExpression(typePath, state);
    if (t.isConditionalExpression(typePathRef.node)) {
      createOpcodesForConditionalExpressionTemplate(
        typePathRef,
        opcodes,
        state,
        (conditionalPath, conditionalOpcodes) => {
          createOpcodesForReactCreateElementType(conditionalPath, args, conditionalOpcodes, state, componentPath);
        },
      );
      return;
    }
    invariant(false, "TODO");
  } else {
    let componentName;
    let attributesPath = null;
    let childrenPath = null;

    if (args.length > 1) {
      const configPath = args[1];
      const configPathRef = getReferenceFromExpression(configPath, state);

      if (t.isNullLiteral(configPathRef.node)) {
        // NO-OP
      } else if (t.isObjectExpression(configPathRef.node)) {
        attributesPath = configPathRef.get("properties");
      } else if (t.isCallExpression(configPathRef.node)) {
        attributesPath = configPathRef;
      } else {
        invariant(false, "TODO");
      }
    }
    if (args.length > 2) {
      childrenPath = args.slice(2);
    }

    if (isReferenceReactContextProvider(typePath, state)) {
      const contextObjectRuntimeValueIndex = getContextObjectRuntimeValueIndex(typePath, state);
      const hostNodeId = Symbol();
      pushOpcode(opcodes, "OPEN_CONTEXT_PROVIDER", contextObjectRuntimeValueIndex);
      createOpcodesForReactCreateElementHostComponent(hostNodeId, null, args, opcodes, state, componentPath);
      pushOpcode(opcodes, "CLOSE_CONTEXT_PROVIDER");
      return;
    } else if (isReferenceReactContextConsumer(typePath, state)) {
      createOpcodesForReactContextConsumer(typePath, childrenPath, opcodes, state, componentPath);
      return;
    } else if (t.isIdentifier(typePath.node)) {
      componentName = typePath.node.name;
    } else if (t.isFunctionDeclaration(typePath.node)) {
      componentName = typePath.node.id.name;
    } else if (isReactFragment(typePath, state)) {
      createOpcodesForReactCreateElementFragment(args, opcodes, state, componentPath);
      return;
    } else {
      invariant(false, "TODO");
    }

    createOpcodesForCompositeComponent(
      typePath,
      componentName,
      attributesPath,
      childrenPath,
      opcodes,
      state,
      componentPath,
    );
  }
}

export function createOpcodesForReactCreateElement(path, opcodes, state, componentPath) {
  markNodeAsDCE(path.node);
  if (t.isMemberExpression(path.node.callee)) {
    markNodeAsDCE(path.node.callee.object);
  }
  const args = path.get("arguments");

  if (args.length === 0) {
    throw new Error(
      `Compiler failed to due React.createElement() called with no arguments at ${getCodeLocation(path.node)}`,
    );
  }
  const typePath = args[0];

  createOpcodesForReactCreateElementType(typePath, args, opcodes, state, componentPath);

  if (t.isBlockStatement(path.node)) {
    const body = path.get("body");
    const returnStatement = body[body.length - 1];
    if (t.isReturnStatement(returnStatement)) {
      returnStatement.get("argument").replaceWith(emptyObject);
    } else {
      invariant(false, "Should never happen");
    }
  } else {
    path.replaceWith(emptyObject);
  }
}
