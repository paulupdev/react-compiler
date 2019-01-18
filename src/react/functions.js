import { pushOpcode, pushOpcodeValue } from "../opcodes";
import { getBindingPathRef, getReferenceFromExpression } from "../references";
import {
  emptyObject,
  getComponentName,
  getShapeOfPropsObject,
  isPrimitive,
  isReactHook,
  isRootPathConditional,
  markNodeAsUsed,
  normalizeOpcodes,
} from "../utils";
import { getTypeAnnotationForExpression } from "../annotations";
import { applyCachedRuntimeValues } from "../transforms";
import { createOpcodesForNode } from "../nodes";
import invariant from "../invariant";
import * as t from "@babel/types";

function createOpcodesForTemplateBranch(
  templateBranch,
  templateBranchIndex,
  state,
  componentPath,
  processNodeValueFunc,
) {
  const opcodes = [];
  const runtimeValues = new Map();
  if (templateBranchIndex !== null) {
    runtimeValues.set(t.numericLiteral(templateBranchIndex), {
      index: 0,
      references: 1,
    });
  }
  const childState = { ...state, ...{ runtimeValues } };
  // Get the argument from the return statement
  const isExplicitReturn = templateBranch.isExplicitReturn;
  const path = isExplicitReturn ? templateBranch.path.get("argument") : templateBranch.path;
  const refPath = getReferenceFromExpression(path, state);
  const originalPathNode = path.node;

  createOpcodesForNode(path, refPath, opcodes, childState, componentPath, true, processNodeValueFunc);

  const isStatic = runtimeValues.size === 0;
  // replace branch with values array
  const runtimeValuesArray = [];
  for (let [runtimeValue, { index }] of runtimeValues) {
    runtimeValuesArray[index] = runtimeValue;
  }
  if (!path.removed) {
    if (path.node === originalPathNode || path.node === emptyObject) {
      path.replaceWith(t.arrayExpression(runtimeValuesArray));
    } else if (t.isBlockStatement(path.node)) {
      for (let blockNode of path.node.body) {
        if (
          t.isReturnStatement(blockNode) &&
          (blockNode.argument === originalPathNode || blockNode.argument === emptyObject)
        ) {
          blockNode.argument = t.arrayExpression(runtimeValuesArray);
          break;
        }
      }
    } else {
      throw new Error("TODO");
    }
  }
  return [opcodes, isStatic];
}

function createOpcodesForTemplateBranches(
  templateBranches,
  opcodes,
  computeFunction,
  state,
  functionPath,
  contextObjectRuntimeValueIndex,
  processNodeValueFunc,
) {
  if (templateBranches.length === 1) {
    const templateBranch = templateBranches[0];
    if (contextObjectRuntimeValueIndex !== null) {
      pushOpcode(opcodes, "CONTEXT_CONSUMER_UNCONDITIONAL_TEMPLATE", contextObjectRuntimeValueIndex);
    } else {
      pushOpcode(opcodes, "UNCONDITIONAL_TEMPLATE");
    }
    const [opcodesForTemplateBranch, isBranchStatic] = createOpcodesForTemplateBranch(
      templateBranch,
      null,
      state,
      functionPath,
      processNodeValueFunc,
    );
    pushOpcodeValue(opcodes, normalizeOpcodes(opcodesForTemplateBranch));
    return isBranchStatic;
  } else {
    // Check how many non primitive roots we have
    const nonPrimitiveRoots = templateBranches.filter(branch => !branch.isPrimitive);

    if (nonPrimitiveRoots.length === 1) {
      // Optimization path, for where all roots, but one, are primitives. We don't need
      // to use a conditional root return.
      const templateBranch = nonPrimitiveRoots[0];
      if (contextObjectRuntimeValueIndex !== null) {
        pushOpcode(opcodes, "CONTEXT_CONSUMER_TEMPLATE", contextObjectRuntimeValueIndex);
      } else {
        pushOpcode(opcodes, "TEMPLATE");
      }
      const [opcodesForTemplateBranch, isBranchStatic] = createOpcodesForTemplateBranch(
        templateBranch,
        null,
        state,
        functionPath,
        processNodeValueFunc,
      );
      pushOpcodeValue(opcodes, normalizeOpcodes(opcodesForTemplateBranch));
      return isBranchStatic;
    } else {
      const opcodesTemplate = [];
      const opcodesForTemplateBranches = [];
      if (contextObjectRuntimeValueIndex !== null) {
        pushOpcode(opcodesTemplate, "CONTEXT_CONSUMER_CONDITIONAL_TEMPLATE", contextObjectRuntimeValueIndex);
      } else {
        pushOpcode(opcodesTemplate, "CONDITIONAL_TEMPLATE");
      }
      const reconcilerValueIndexForHostNode = state.reconciler.valueIndex++;
      pushOpcodeValue(opcodesTemplate, reconcilerValueIndexForHostNode, "HOST_NODE_VALUE_POINTER_INDEX");
      const reconcilerValueIndexForBranchMountOpcodes = state.reconciler.valueIndex++;
      pushOpcodeValue(opcodesTemplate, reconcilerValueIndexForBranchMountOpcodes, "BRANCH_OPCODES_VALUE_POINTER_INDEX");
      let templateBranchIndex = 0;
      let isStatic = true;

      for (let templateBranch of templateBranches) {
        if (!templateBranch.isPrimitive) {
          pushOpcodeValue(opcodesForTemplateBranches, templateBranchIndex, "CONDITIONAL_ROOT_INDEX");
          const [opcodesForTemplateBranch, isBranchStatic] = createOpcodesForTemplateBranch(
            templateBranch,
            templateBranchIndex,
            state,
            functionPath,
            processNodeValueFunc,
          );
          if (!isBranchStatic) {
            isStatic = false;
          }
          pushOpcodeValue(opcodesForTemplateBranches, normalizeOpcodes(opcodesForTemplateBranch));
          templateBranchIndex++;
        }
      }
      if (!isStatic) {
        const mergedOpcodes = [...opcodesTemplate, normalizeOpcodes(opcodesForTemplateBranches)];
        opcodes.push(...mergedOpcodes);
      }
      return isStatic;
    }
  }
}

export function createOpcodesForReactComputeFunction(
  functionPath,
  state,
  isComponentFunction,
  contextObjectRuntimeValueIndex,
  processNodeValueFunc,
) {
  const computeFunction = functionPath.node;
  if (state.computeFunctionCache.has(computeFunction)) {
    return state.computeFunctionCache.get(computeFunction);
  }
  if (isComponentFunction) {
    updateComputeFunctionName(functionPath);
  }

  const templateBranches = [];
  const runtimeConditionals = new Map();
  const runtimeCachedValues = new Map();
  let previousRootWasConditional = false;

  // When the arrow function body is an expression
  if (t.isArrowFunctionExpression(computeFunction) && !t.isBlockStatement(computeFunction.body)) {
    templateBranches.push({
      path: functionPath.get("body"),
      isConditional: false,
      isExplicitReturn: false,
      isPrimitive: isPrimitive(computeFunction.body),
    });
  } else {
    functionPath.traverse({
      ReturnStatement(templatePath) {
        if (templatePath.scope.getFunctionParent() !== functionPath.scope) {
          return;
        }
        const isConditional = previousRootWasConditional || isRootPathConditional(functionPath, templatePath);
        if (isConditional) {
          previousRootWasConditional = true;
        }
        // Replace template note with value array
        const arg = templatePath.node.argument;

        templateBranches.push({
          path: templatePath,
          isConditional,
          isExplicitReturn: true,
          isPrimitive: isPrimitive(arg),
        });
      },
    });
  }

  const childState = {
    ...state,
    ...{
      runtimeCachedValues,
      runtimeConditionals,
    },
  };
  const templateOpcodes = [];
  const isStatic = createOpcodesForTemplateBranches(
    templateBranches,
    templateOpcodes,
    computeFunction,
    childState,
    functionPath,
    contextObjectRuntimeValueIndex,
    processNodeValueFunc,
  );

  let computeFunctionOpcodes;
  if (isComponentFunction) {
    computeFunctionOpcodes = [];
    if (isStatic) {
      pushOpcodeValue(computeFunctionOpcodes, t.numericLiteral(0), "COMPUTE_FUNCTION");
    } else {
      pushOpcodeValue(computeFunctionOpcodes, t.identifier(getComponentName(functionPath)), "COMPUTE_FUNCTION");
      const reconcilerValueIndex = state.reconciler.valueIndex++;
      pushOpcodeValue(computeFunctionOpcodes, reconcilerValueIndex, "VALUE_POINTER_INDEX");
    }
  }

  state.computeFunctionCache.set(computeFunction, {
    cachedOpcodes: null,
    computeFunctionOpcodes,
    isStatic,
    templateOpcodes,
  });

  applyCachedRuntimeValues(functionPath, runtimeCachedValues);

  return {
    cachedOpcodes: null,
    computeFunctionOpcodes,
    isStatic,
    templateOpcodes,
  };
}

function getDefaultPropsObjectExpressionPath(binding, state) {
  if (binding !== undefined) {
    for (let referencePath of binding.referencePaths) {
      let parentPath = referencePath.parentPath;

      if (
        t.isMemberExpression(parentPath.node) &&
        t.isIdentifier(parentPath.node.property) &&
        parentPath.node.property.name === "defaultProps"
      ) {
        parentPath = parentPath.parentPath;
        if (t.isAssignmentExpression(parentPath.node)) {
          const rightPath = parentPath.get("right");
          const rightPathRef = getReferenceFromExpression(rightPath, state);
          if (t.isObjectExpression(rightPathRef.node)) {
            return rightPathRef;
          }
        }
      }
    }
  } else {
    throw new Error("TODO");
  }
  return null;
}

export function createOpcodesForReactFunctionComponent(componentPath, state) {
  const computeFunction = componentPath.node;
  const name = getComponentName(componentPath);
  const functionKind = componentPath.scope.getBinding(name).kind;
  const binding = getBindingPathRef(componentPath, name, state);
  const shapeOfPropsObject = getShapeOfPropsObject(componentPath, state);
  const typeAnnotation = getTypeAnnotationForExpression(componentPath, state, false);
  const defaultProps = getDefaultPropsObjectExpressionPath(binding, state);
  const result = {
    componentPath,
    computeFunction,
    defaultProps,
    functionKind,
    isStatic: false,
    shapeOfPropsObject,
    typeAnnotation,
  };
  state.compiledComponentCache.set(name, result);
  const opcodes = [];

  pushOpcode(opcodes, "COMPONENT");
  pushOpcodeValue(opcodes, doesFunctionComponentUseHooks(componentPath, state) ? 1 : 0, "USES_HOOKS");

  const { computeFunctionOpcodes, isStatic, templateOpcodes } = createOpcodesForReactComputeFunction(
    componentPath,
    state,
    true,
    null,
    null,
  );
  result.isStatic = isStatic;

  if (state.isRootComponent) {
    if (shapeOfPropsObject !== null) {
      pushOpcodeValue(
        opcodes,
        t.arrayExpression(shapeOfPropsObject.map(a => t.stringLiteral(a.value))),
        "ROOT_PROPS_SHAPE",
      );
    } else {
      pushOpcodeValue(opcodes, t.numericLiteral(0), "ROOT_PROPS_SHAPE");
    }
  }
  opcodes.push(...computeFunctionOpcodes);
  pushOpcodeValue(opcodes, t.arrayExpression(templateOpcodes));

  const opcodesArray = normalizeOpcodes(opcodes);
  opcodesArray.leadingComments = [{ type: "BlockComment", value: ` ${name} OPCODES` }];

  insertComputFunctionCachedOpcodes(componentPath, state);

  // Re-write function props as arguments
  rewriteArgumentsForComputeFunction(computeFunction, shapeOfPropsObject);
  // Re-write the function as a compute function with opcodes emitted
  convertFunctionComponentToComputeFunctionAndEmitOpcodes(
    componentPath,
    computeFunction,
    isStatic,
    name,
    opcodesArray,
    state.isRootComponent,
  );
  return result;
}

function insertComputFunctionCachedOpcodes(componentPath, state) {
  const computeFunctionCache = state.computeFunctionCache;
  if (computeFunctionCache.size > 0) {
    const declarators = [];
    for (let [, { cachedOpcodes }] of computeFunctionCache) {
      if (cachedOpcodes !== null) {
        const { node, opcodesArray } = cachedOpcodes;
        if (cachedOpcodes.inserted) {
          continue;
        }
        cachedOpcodes.inserted = true;
        declarators.push(t.variableDeclarator(node, opcodesArray));
      }
    }
    if (declarators.length > 0) {
      componentPath.insertBefore(t.variableDeclaration("var", declarators));
    }
  }
}

function updateComputeFunctionName(functionPath) {
  const name = getComponentName(functionPath);
  // Change compute function name
  if (t.isFunctionDeclaration(functionPath.node) && t.isIdentifier(functionPath.node.id)) {
    functionPath.node.id.name = `${name}_ComputeFunction`;
  } else {
    const parentPath = functionPath.parentPath;
    if (t.isVariableDeclarator(parentPath.node) && t.isIdentifier(parentPath.node.id)) {
      parentPath.node.id.name = `${name}_ComputeFunction`;
    } else {
      invariant(false, "TODO");
    }
  }
}

function rewriteArgumentsForComputeFunction(computeFunction, shapeOfPropsObject) {
  const params = computeFunction.params;

  if (params.length > 0 && t.isObjectPattern(params[0])) {
    computeFunction.params = shapeOfPropsObject.map(a => t.identifier(a.value));
  }
}

function doesFunctionComponentUseHooks(componentPath, state) {
  let usesHooks = false;
  componentPath.traverse({
    CallExpression(path) {
      if (isReactHook(path, state)) {
        markNodeAsUsed(path.node);
        usesHooks = true;
      }
    },
  });
  return usesHooks;
}

function convertFunctionComponentToComputeFunctionAndEmitOpcodes(
  componentPath,
  computeFunction,
  isStatic,
  name,
  opcodesArray,
  isRootComponent,
) {
  if (t.isFunctionDeclaration(computeFunction)) {
    const identifier = t.identifier(name);
    markNodeAsUsed(identifier);
    if (isRootComponent) {
      if (isStatic) {
        componentPath.replaceWith(t.variableDeclaration("var", [t.variableDeclarator(identifier, opcodesArray)]));
      } else {
        const opcodesArrayDeclaration = t.variableDeclaration("var", [t.variableDeclarator(identifier, opcodesArray)]);
        if (
          t.isExportDefaultDeclaration(componentPath.parentPath.node) ||
          t.isExportNamedDeclaration(componentPath.parentPath.node)
        ) {
          const exportNode = t.isExportDefaultDeclaration(componentPath.parentPath.node)
            ? t.exportDefaultDeclaration(opcodesArrayDeclaration)
            : t.exportNamedDeclaration(opcodesArrayDeclaration, []);
          componentPath.parentPath.replaceWithMultiple([computeFunction, exportNode]);
        } else {
          componentPath.replaceWithMultiple([computeFunction, opcodesArrayDeclaration]);
        }
      }
    } else {
      const arrayWrapperFunction = t.functionDeclaration(
        identifier,
        [],
        t.blockStatement([t.returnStatement(opcodesArray)]),
      );
      if (isStatic) {
        componentPath.replaceWith(arrayWrapperFunction);
      } else {
        if (
          t.isExportDefaultDeclaration(componentPath.parentPath.node) ||
          t.isExportNamedDeclaration(componentPath.parentPath.node)
        ) {
          const exportNode = t.isExportDefaultDeclaration(componentPath.parentPath.node)
            ? t.exportDefaultDeclaration(arrayWrapperFunction)
            : t.exportNamedDeclaration(arrayWrapperFunction, []);
          componentPath.parentPath.replaceWithMultiple([computeFunction, exportNode]);
        } else {
          componentPath.replaceWithMultiple([computeFunction, arrayWrapperFunction]);
        }
      }
    }
  } else {
    const parentPath = componentPath.parentPath;

    if (t.isVariableDeclarator(parentPath.node) && t.isIdentifier(parentPath.node.id)) {
      markNodeAsUsed(parentPath.node.id);
      const identifier = t.identifier(name);
      markNodeAsUsed(identifier);

      if (isRootComponent) {
        if (isStatic) {
          parentPath.node.id.name = name;
          componentPath.replaceWith(opcodesArray);
        } else {
          parentPath.replaceWithMultiple([parentPath.node, t.variableDeclarator(identifier, opcodesArray)]);
        }
      } else {
        const arrayWrapperFunction = t.variableDeclarator(
          identifier,
          t.functionExpression(null, [], t.blockStatement([t.returnStatement(opcodesArray)])),
        );
        if (isStatic) {
          parentPath.node.id.name = name;
          componentPath.replaceWith(arrayWrapperFunction);
        } else {
          parentPath.replaceWithMultiple([parentPath.node, arrayWrapperFunction]);
        }
      }
    } else {
      invariant(false, "TODO");
    }
  }
}
