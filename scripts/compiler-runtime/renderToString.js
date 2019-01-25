import { currentDispatcher } from "./index";
import { Dispatcher, finishHooks, prepareToUseHooks } from "./ssr-dispatcher";
import {
  callComputeFunctionWithArray,
  convertRootPropsToPropsArray,
  createMarkupForRoot,
  emptyArray,
  escapeText,
  getCurrentContextValue,
  insertChildFiberIntoParentFiber,
  isArray,
  isReactNode,
  popCurrentContextValue,
  pushCurrentContextValue,
  reactElementSymbol,
} from "./utils";

export const ROOT_COMPONENT = 0;
export const COMPONENT = 1;
export const HOST_COMPONENT = 2;
export const TEXT = 3;
export const FRAGMENT = 4;
export const CONDITIONAL = 5;
export const TEMPLATE_FUNCTION_CALL = 6;
export const MULTI_CONDITIONAL = 7;

export const HAS_STATIC_PROPS = 1 << 6;
export const HAS_DYNAMIC_PROPS = 1 << 7;
export const HAS_CHILD = 1 << 8;
export const HAS_CHILDREN = 1 << 9;
export const HAS_STATIC_TEXT_CONTENT = 1 << 10;
export const HAS_DYNAMIC_TEXT_CONTENT = 1 << 11;
export const IS_STATIC = 1 << 12;
export const IS_SVG = 1 << 13;
export const IS_VOID = 1 << 14;

function renderReactNodeToString(node, isChild, runtimeValues, state, currentFiber) {
  if (node === null || node === undefined || typeof node === "boolean") {
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    if (isChild) {
      if (state.lastChildWasTextNode === true) {
        state.renderString += "<!-- -->";
      }
      state.lastChildWasTextNode = true;
    }
    state.renderString += escapeText(node);
  } else if (isReactNode(node)) {
    state.lastChildWasTextNode = false;
    const templateOpcodes = node.t;
    let templateRuntimeValues = node.v;
    if (templateRuntimeValues === null) {
      templateRuntimeValues = emptyArray;
    }
    renderOpcodesToString(templateOpcodes, templateRuntimeValues, state, currentFiber);
  } else if (isArray(node)) {
    for (let i = 0, length = node.length; i < length; ++i) {
      const elementNode = node[i];
      renderReactNodeToString(elementNode, isChild, runtimeValues, state, currentFiber);
    }
  }
}

function renderValueToString(value, state, isChild) {
  if (isArray(value)) {
    const childrenTextArrayLength = value.length;
    for (let i = 0; i < childrenTextArrayLength; ++i) {
      const childText = value[i];
      if (childText !== null && childText !== undefined && typeof childText !== "boolean") {
        if ((isChild === true && state.lastChildWasTextNode === true) || i !== 0) {
          state.renderString += "<!-- -->";
        }
        state.renderString += escapeText(childText);
      }
    }
  } else if (value !== null && value !== undefined && typeof value !== "boolean") {
    if (isChild === true) {
      if (state.lastChildWasTextNode === true) {
        state.renderString += "<!-- -->";
      }
      state.lastChildWasTextNode = true;
    }
    state.renderString += escapeText(value);
  }
}

function renderElementCloseRenderString(state) {
  if (state.currentElementTagIsOpen === true) {
    state.renderString += state.elementCloseRenderString;
    state.currentElementTagIsOpen = false;
  }
}

function renderStyleValue(styleName, styleValue, state) {
  let delimiter = "";
  if (state.lastChildWasStyle === true) {
    delimiter = ";";
  } else {
    state.lastChildWasStyle = true;
  }
  state.styleRenderString += `${delimiter}${styleName}:${styleValue}`;
}

function renderOpcodesToString(opcodes, runtimeValues, state, currentFiber) {
  const opcodesLength = opcodes.length;
  let index = 0;

  // Render opcodes from the opcode jump-table
  while (index < opcodesLength) {
    const opcode = opcodes[index];

    switch (opcode) {
      case REF_COMPONENT: {
        const componentOpcodesFunction = opcodes[++index];
        const componentOpcodeCache = state.componentOpcodeCache;
        let componentOpcodes = componentOpcodeCache.get(componentOpcodesFunction);
        if (componentOpcodes === undefined) {
          componentOpcodes = componentOpcodesFunction();
          componentOpcodeCache.set(componentOpcodesFunction, componentOpcodes);
        } else {
          componentOpcodes = componentOpcodeCache.get(componentOpcodesFunction);
        }
        const propsValuePointerOrValue = opcodes[++index];
        let propsValue = null;
        if (isArray(propsValuePointerOrValue)) {
          propsValue = propsValuePointerOrValue;
        } else if (propsValuePointerOrValue !== null) {
          propsValue = runtimeValues[propsValuePointerOrValue];
        }
        state.props = propsValue;
        renderOpcodesToString(componentOpcodes, runtimeValues, state, currentFiber);
        break;
      }
      case STATIC_PROP: {
        const propName = opcodes[++index];
        const staticPropValue = opcodes[++index];

        if (staticPropValue !== null && staticPropValue !== undefined) {
          state.renderString += ` ${propName}="${staticPropValue}"`;
        }
        break;
      }
      case DYNAMIC_PROP: {
        const propName = opcodes[++index];
        const propInformation = opcodes[++index];
        const dynamicPropValuePointer = opcodes[++index];
        const dynamicPropValue = runtimeValues[dynamicPropValuePointer];

        if (propInformation & PropFlagPartialTemplate) {
          throw new Error("TODO renderStaticProp");
        } else if (propInformation & PropFlagReactEvent) {
          ++index; // Event data
          state.renderString += "";
        } else if (dynamicPropValue !== null && dynamicPropValue !== undefined) {
          state.renderString += ` ${propName}="${dynamicPropValue}"`;
        }
        break;
      }
      case STATIC_PROP_CLASS_NAME: {
        const staticClassName = opcodes[++index];
        if (staticClassName !== null && staticClassName !== undefined) {
          state.renderString += ` class="${staticClassName}"`;
        }
        break;
      }
      case DYNAMIC_PROP_CLASS_NAME: {
        const propInformation = opcodes[++index];
        const dynamicClassNamePointer = opcodes[++index];
        const dynamicClassName = runtimeValues[dynamicClassNamePointer];

        if (propInformation & PropFlagPartialTemplate) {
          throw new Error("TODO renderDynamicClassNameProp");
        } else if (dynamicClassName !== null && dynamicClassName !== undefined) {
          state.renderString += ` class="${escapeText(dynamicClassName)}"`;
        }
        break;
      }
      case STATIC_PROP_VALUE: {
        const staticValueProp = opcodes[++index];
        if (typeof state.currentElementTag !== "string") {
          pushCurrentContextValue(state.currentElementTag, staticValueProp, state);
        } else if (staticValueProp !== null && staticValueProp !== undefined) {
          state.renderString += ` value="${staticValueProp}"`;
        }
        break;
      }
      case DYNAMIC_PROP_VALUE: {
        throw new Error("TODO DYNAMIC_PROP_VALUE");
        break;
      }
      case STATIC_PROP_STYLE: {
        const styleName = opcodes[++index];
        let styleValue = opcodes[++index];

        if (styleValue == null || styleValue === undefined) {
          break;
        }
        if (typeof styleValue === "number") {
          styleValue = `${styleValue}px`;
        }
        renderStyleValue(styleName, styleValue, state);
        break;
      }
      case DYNAMIC_PROP_STYLE: {
        const styleName = opcodes[++index];
        const styleValuePointer = opcodes[++index];
        let styleValue = runtimeValues[styleValuePointer];

        if (styleValue == null || styleValue === undefined) {
          break;
        }
        if (typeof styleValue === "number") {
          styleValue = `${styleValue}px`;
        }
        renderStyleValue(styleName, styleValue, state);
        break;
      }
      case STATIC_PROP_UNITLESS_STYLE: {
        const styleName = opcodes[++index];
        const styleValue = opcodes[++index];

        if (styleValue == null || styleValue === undefined) {
          break;
        }
        renderStyleValue(styleName, styleValue, state);
        break;
      }
      case DYNAMIC_PROP_UNITLESS_STYLE: {
        const styleName = opcodes[++index];
        const styleValuePointer = opcodes[++index];
        const styleValue = runtimeValues[styleValuePointer];

        if (styleValue == null || styleValue === undefined) {
          break;
        }
        renderStyleValue(styleName, styleValue, state);
        break;
      }
      case ELEMENT_STATIC_CHILD_VALUE: {
        if (state.lastChildWasTextNode === true) {
          state.renderString += "<!-- -->";
        }
        renderElementCloseRenderString(state);
        const staticTextChild = opcodes[++index];
        state.renderString += staticTextChild;
        state.lastChildWasTextNode = true;
        break;
      }
      case ELEMENT_STATIC_CHILDREN_VALUE: {
        renderElementCloseRenderString(state);
        const staticTextContent = opcodes[++index];
        state.renderString += staticTextContent;
        break;
      }
      case ELEMENT_DYNAMIC_CHILD_VALUE: {
        renderElementCloseRenderString(state);
        const dynamicTextChildPointer = opcodes[++index];
        ++index; // Host node pointer index
        const dynamicTextChild = runtimeValues[dynamicTextChildPointer];
        renderValueToString(dynamicTextChild, state, true);
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_VALUE: {
        renderElementCloseRenderString(state);
        state.lastChildWasTextNode = false;
        const dynamicTextContentPointer = opcodes[++index];
        ++index; // Host node pointer index
        const dynamicTextContent = runtimeValues[dynamicTextContentPointer];
        renderValueToString(dynamicTextContent, state, false);
        break;
      }
      case ELEMENT_DYNAMIC_CHILD_TEMPLATE_FROM_FUNC_CALL: {
        const templateOpcodes = opcodes[++index];
        const computeValuesPointer = opcodes[++index];
        ++index; // Host node pointer index
        const computeValues = runtimeValues[computeValuesPointer];
        if (computeValues !== null) {
          renderOpcodesToString(templateOpcodes, computeValues, state, currentFiber);
          const currentValue = state.currentValue;

          if (
            currentValue !== null &&
            currentValue !== undefined &&
            typeof currentValue !== "boolean" &&
            currentValue !== ReactElementNode
          ) {
            if (state.lastChildWasTextNode === true) {
              state.renderString += "<!-- -->";
            }
            state.renderString += escapeText(currentValue);
            state.lastChildWasTextNode = true;
          }
        }
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_TEMPLATE_FROM_FUNC_CALL: {
        const templateOpcodes = opcodes[++index];
        const computeValuesPointer = opcodes[++index];
        ++index; // Host node pointer index
        const computeValues = runtimeValues[computeValuesPointer];
        if (computeValues !== null) {
          renderOpcodesToString(templateOpcodes, computeValues, state, currentFiber);
          const currentValue = state.currentValue;

          state.lastChildWasTextNode = false;
          if (
            currentValue !== null &&
            currentValue !== undefined &&
            typeof currentValue !== "boolean" &&
            currentValue !== ReactElementNode
          ) {
            state.renderString += escapeText(currentValue);
          }
        }
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_ARRAY_MAP_TEMPLATE: {
        const arrayPointer = opcodes[++index];
        const arrayMapOpcodes = opcodes[++index];
        const arrayMapComputeFunctionPointer = opcodes[++index];
        const array = runtimeValues[arrayPointer];
        const arrayMapComputeFunction =
          arrayMapComputeFunctionPointer === 0 ? null : runtimeValues[arrayMapComputeFunctionPointer];

        const arrayLength = array.length;
        for (let i = 0; i < arrayLength; ++i) {
          const element = array[i];
          let templateRuntimeValues = runtimeValues;

          if (arrayMapComputeFunction !== null) {
            templateRuntimeValues = arrayMapComputeFunction(element, i, array);
          }
          renderOpcodesToString(arrayMapOpcodes, templateRuntimeValues, state, currentFiber);
        }
        break;
      }
      case ELEMENT_DYNAMIC_CHILD_REACT_NODE_TEMPLATE: {
        renderElementCloseRenderString(state);
        const reactNodeOrArrayPointer = opcodes[++index];
        ++index; // Host node pointer index
        const reactNodeOrArray = runtimeValues[reactNodeOrArrayPointer];
        renderReactNodeToString(reactNodeOrArray, true, runtimeValues, state, currentFiber);
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_REACT_NODE_TEMPLATE: {
        renderElementCloseRenderString(state);
        const reactNodeOrArrayPointer = opcodes[++index];
        ++index; // Host node pointer index
        const reactNodeOrArray = runtimeValues[reactNodeOrArrayPointer];
        state.lastChildWasTextNode = false;
        renderReactNodeToString(reactNodeOrArray, false, runtimeValues, state, currentFiber);
        break;
      }
      case ELEMENT_DYNAMIC_FUNCTION_CHILD: {
        throw new Error("TODO ELEMENT_DYNAMIC_FUNCTION_CHILD");
        break;
      }
      case OPEN_PROP_STYLE: {
        state.styleRenderString = "";
        state.lastChildWasStyle = false;
        break;
      }
      case CLOSE_PROP_STYLE: {
        if (state.styleRenderString !== "") {
          state.renderString += ` style="${state.styleRenderString}"`;
        }
        break;
      }
      case OPEN_ELEMENT_DIV_WITH_POINTER:
      case OPEN_ELEMENT_DIV: {
        if (state.currentElementTag !== "") {
          state.elementTagStack[state.elementTagStackIndex++] = state.currentElementTag;
        }
        renderElementCloseRenderString(state);
        state.elementCloseRenderString = "";
        state.renderString += "<div";
        state.currentElementTag = "div";
        state.currentValue = ReactElementNode;
        state.currentElementTagIsOpen = true;
        state.lastChildWasTextNode = false;
        if (state.hasMarkedRootElement === false) {
          state.hasMarkedRootElement = true;
          state.elementCloseRenderString += ` ${createMarkupForRoot()}`;
        }
        state.elementCloseRenderString += ">";
        if (opcode === OPEN_ELEMENT_DIV_WITH_POINTER) {
          ++index;
        }
        break;
      }
      case OPEN_ELEMENT_SPAN_WITH_POINTER:
      case OPEN_ELEMENT_SPAN: {
        if (state.currentElementTag !== "") {
          state.elementTagStack[state.elementTagStackIndex++] = state.currentElementTag;
        }
        renderElementCloseRenderString(state);
        state.elementCloseRenderString = "";
        state.renderString += "<span";
        state.currentElementTag = "span";
        state.currentValue = ReactElementNode;
        state.currentElementTagIsOpen = true;
        state.lastChildWasTextNode = false;
        if (state.hasMarkedRootElement === false) {
          state.hasMarkedRootElement = true;
          state.elementCloseRenderString += ` ${createMarkupForRoot()}`;
        }
        state.elementCloseRenderString += ">";
        if (opcode === OPEN_ELEMENT_SPAN_WITH_POINTER) {
          ++index;
        }
        break;
      }
      case OPEN_ELEMENT_WITH_POINTER:
      case OPEN_ELEMENT: {
        if (state.currentElementTag !== "") {
          state.elementTagStack[state.elementTagStackIndex++] = state.currentElementTag;
        }
        renderElementCloseRenderString(state);
        state.elementCloseRenderString = "";
        const currentElementTag = (state.currentElementTag = opcodes[++index]);
        state.renderString += `<${currentElementTag}`;
        state.currentValue = ReactElementNode;
        state.currentElementTagIsOpen = true;
        state.lastChildWasTextNode = false;
        if (state.hasMarkedRootElement === false) {
          state.hasMarkedRootElement = true;
          state.elementCloseRenderString += ` ${createMarkupForRoot()}`;
        }
        state.elementCloseRenderString += ">";
        if (opcode === OPEN_ELEMENT_WITH_POINTER) {
          ++index;
        }
        break;
      }
      case CLOSE_ELEMENT: {
        renderElementCloseRenderString(state);
        state.lastChildWasTextNode = false;
        state.renderString += `</${state.currentElementTag}>`;
        const elementTagStack = state.elementTagStack;
        const elementTagStackIndex = --state.elementTagStackIndex;
        state.currentElementTag = elementTagStack[elementTagStackIndex];
        elementTagStack[elementTagStackIndex] = null;
        break;
      }
      case OPEN_FRAGMENT: {
        renderElementCloseRenderString(state);
        state.elementCloseRenderString = "";
        state.lastChildWasTextNode = false;
        if (state.hasMarkedRootElement === false) {
          state.hasMarkedRootElement = true;
        }
        break;
      }
      case CLOSE_FRAGMENT: {
        break;
      }
      case OPEN_VOID_ELEMENT_WITH_POINTER:
      case OPEN_VOID_ELEMENT: {
        if (state.currentElementTag !== "") {
          state.elementTagStack[state.elementTagStackIndex++] = state.currentElementTag;
        }
        renderElementCloseRenderString(state);
        state.elementCloseRenderString = "";
        const currentElementTag = (state.currentElementTag = opcodes[++index]);
        state.renderString += `<${currentElementTag}`;
        state.currentValue = ReactElementNode;
        state.currentElementTagIsOpen = true;
        state.lastChildWasTextNode = false;
        if (state.hasMarkedRootElement === false) {
          state.hasMarkedRootElement = true;
          state.elementCloseRenderString += ` ${createMarkupForRoot()}`;
        }
        state.elementCloseRenderString += "/>";
        if (opcode === OPEN_VOID_ELEMENT_WITH_POINTER) {
          ++index;
        }
        break;
      }
      case CLOSE_VOID_ELEMENT: {
        renderElementCloseRenderString(state);
        const elementTagStack = state.elementTagStack;
        const elementTagStackIndex = --state.elementTagStackIndex;
        state.currentElementTag = elementTagStack[elementTagStackIndex];
        elementTagStack[elementTagStackIndex] = null;
        break;
      }
      case CONDITIONAL: {
        ++index; // hostNodeValuePointer
        const conditionValuePointer = opcodes[++index];
        const conditionValue = runtimeValues[conditionValuePointer];
        const consequentOpcodes = opcodes[++index];

        if (conditionValue) {
          if (consequentOpcodes !== 0) {
            renderOpcodesToString(consequentOpcodes, runtimeValues, state, currentFiber);
          }
          ++index;
          break;
        }
        const alternateOpcodes = opcodes[++index];
        if (alternateOpcodes !== 0) {
          renderOpcodesToString(alternateOpcodes, runtimeValues, state, currentFiber);
        }
        break;
      }
      case LOGICAL_OR: {
        const leftOpcodes = opcodes[++index];
        const rightOpcodes = opcodes[++index];

        state.currentValue = undefined;
        renderOpcodesToString(leftOpcodes, runtimeValues, state, currentFiber);
        if (state.currentValue === undefined) {
          renderOpcodesToString(rightOpcodes, runtimeValues, state, currentFiber);
        }
        break;
      }
      case LOGICAL_AND: {
        const leftOpcodes = opcodes[++index];
        const rightOpcodes = opcodes[++index];

        state.currentValue = undefined;
        const clonedState = cloneState(state);
        renderOpcodesToString(leftOpcodes, runtimeValues, state, currentFiber);
        if (state.currentValue !== undefined) {
          applyState(state, clonedState);
          renderOpcodesToString(rightOpcodes, runtimeValues, state, currentFiber);
        }
        break;
      }
      case TEMPLATE_FROM_FUNC_CALL: {
        const templateOpcodes = opcodes[++index];
        const computeValuesPointer = opcodes[++index];
        const computeValues = runtimeValues[computeValuesPointer];
        renderOpcodesToString(templateOpcodes, computeValues, state, currentFiber);
        break;
      }
      case REACT_NODE_TEMPLATE_FROM_FUNC_CALL: {
        const reactNodePointer = opcodes[++index];
        const reactNode = runtimeValues[reactNodePointer];
        renderReactNodeToString(reactNode, false, runtimeValues, state, currentFiber);
        break;
      }
      case CONTEXT_CONSUMER: {
        const reactContextObjectPointer = opcodes[++index];
        const computeFunctionPointer = opcodes[++index];
        const contextConsumerOpcodes = opcodes[++index];
        const computeFunction = runtimeValues[computeFunctionPointer];
        const reactContextObject = runtimeValues[reactContextObjectPointer];
        const contextValue = getCurrentContextValue(reactContextObject, state);
        const contextConsumerRuntimeValues = computeFunction(contextValue);
        renderOpcodesToString(contextConsumerOpcodes, contextConsumerRuntimeValues, state, currentFiber);
        break;
      }
      case CONDITIONAL_TEMPLATE: {
        ++index; // Host node pointer index
        ++index; // Branch opcodes pointer index
        const conditionBranchOpcodes = opcodes[++index];
        if (runtimeValues === null) {
          break;
        }
        let templateRuntimeValues = runtimeValues;
        let branchIndex = 0;
        const conditionBranchOpcodesLength = conditionBranchOpcodes.length;
        const conditionBranchToUseKey = templateRuntimeValues[0];

        while (branchIndex < conditionBranchOpcodesLength) {
          const branchConditionKey = conditionBranchOpcodes[branchIndex];
          if (branchConditionKey === conditionBranchToUseKey) {
            const templateOpcodes = conditionBranchOpcodes[++branchIndex];
            renderOpcodesToString(templateOpcodes, templateRuntimeValues, state, currentFiber);
            break;
          }
          branchIndex += 2;
        }
        break;
      }
      case MULTI_CONDITIONAL: {
        const conditionalSize = opcodes[++index];
        ++index; // Value pointer index
        ++index; // Case pointer index
        const startingIndex = index;
        const conditionalDefaultIndex = conditionalSize - 1;
        for (let conditionalIndex = 0; conditionalIndex < conditionalSize; ++conditionalIndex) {
          if (conditionalIndex === conditionalDefaultIndex) {
            const defaultCaseOpcodes = opcodes[++index];
            if (defaultCaseOpcodes !== null) {
              renderOpcodesToString(defaultCaseOpcodes, runtimeValues, state, currentFiber);
            }
          } else {
            const caseConditionPointer = opcodes[++index];
            const caseConditionValue = runtimeValues[caseConditionPointer];
            if (caseConditionValue) {
              const caseOpcodes = opcodes[++index];
              if (caseOpcodes !== null) {
                renderOpcodesToString(caseOpcodes, runtimeValues, state, currentFiber);
              }
              break;
            }
            ++index;
          }
        }
        index = startingIndex + (conditionalSize - 1) * 2 + 1;
        break;
      }
      case COMPONENT: {
        const usesHooks = opcodes[++index];
        let props;

        // Handle root component props
        if (currentFiber === null) {
          const rootPropsShape = opcodes[++index];
          props = convertRootPropsToPropsArray(state.rootPropsObject, rootPropsShape);
        } else {
          props = state.props;
        }
        const computeFunction = opcodes[++index];
        const componentFiber = createOpcodeFiber(null, props, null);
        let componentRuntimeValues = runtimeValues;
        if (computeFunction !== 0) {
          if (usesHooks === 1) {
            prepareToUseHooks(componentFiber);
          }
          componentRuntimeValues = computeFunction.apply(null, props);
          if (usesHooks === 1) {
            finishHooks(componentFiber);
          }
        }
        if (currentFiber === null) {
          // Root
          state.fiber = componentFiber;
        } else {
          insertChildFiberIntoParentFiber(currentFiber, componentFiber);
        }
        if (componentRuntimeValues !== null) {
          const creationOpcodes = opcodes[++index];
          const previousValue = state.currentValue;
          state.currentValue = undefined;
          renderOpcodesToString(creationOpcodes, componentRuntimeValues, state, componentFiber);
          const currentValue = state.currentValue;
          if (currentValue !== null && currentValue !== undefined && currentValue !== ReactElementNode) {
            state.renderString += escapeText(currentValue);
          }
          state.currentValue = previousValue;
        }
        break;
      }
      case OPEN_CONTEXT_PROVIDER: {
        if (state.currentElementTag !== "") {
          state.elementTagStack.push(state.currentElementTag);
        }
        renderElementCloseRenderString(state);
        state.elementCloseRenderString = "";
        state.currentElementTagIsOpen = true;
        state.lastChildWasTextNode = false;
        if (state.hasMarkedRootElement === false) {
          state.hasMarkedRootElement = true;
        }
        const reactContextObjectPointer = opcodes[++index];
        const reactContextObject = runtimeValues[reactContextObjectPointer];
        pushCurrentContextValue(reactContextObject, undefined, state);
        state.currentElementTag = reactContextObject;
        break;
      }
      case CLOSE_CONTEXT_PROVIDER: {
        popCurrentContextValue(state.currentElementTag, state);
        break;
      }
      case ROOT_STATIC_VALUE: {
        const staticValue = opcodes[++index];
        state.currentValue = staticValue;
        return;
      }
      case ROOT_DYNAMIC_VALUE: {
        const dynamicValuePointer = opcodes[++index];
        let value = runtimeValues[dynamicValuePointer];
        if (isReactNode(value)) {
          value = renderReactNodeToString(value, false, runtimeValues, state, currentFiber);
        } else {
          state.currentValue = value;
        }
        return;
      }
      case DYNAMIC_PROP_REF:
      default: {
        index += 3;
        continue;
      }
    }
    ++index;
  }
}

function renderFunctionComponentTemplateToString(
  isRoot,
  templateTypeAndFlags,
  componentTemplate,
  values,
  isOnlyChild,
  state,
) {
  const templateFlags = templateTypeAndFlags & ~0x3f;

  if ((templateFlags & IS_STATIC) === 0) {
    let componentProps = null;
    const componentPropsValueIndexOrPropsShape = componentTemplate[1];
    if (isRoot === true) {
      componentProps = convertRootPropsToPropsArray(state.rootProps, componentPropsValueIndexOrPropsShape);
    } else {
      componentProps = values[componentPropsValueIndexOrPropsShape];
    }
    const computeFunction = componentTemplate[2];
    const componentValues = callComputeFunctionWithArray(computeFunction, componentProps);
    const childTemplateNode = componentTemplate[3];
    return renderTemplateToString(childTemplateNode, componentValues, isOnlyChild, state);
  }
  const childTemplateNode = componentTemplate[1];
  return renderTemplateToString(childTemplateNode, values, isOnlyChild, state);
}

function renderHostComponentTemplateToString(templateTypeAndFlags, hostComponentTemplate, values, isOnlyChild, state) {
  const templateFlags = templateTypeAndFlags & ~0x3f;
  const tagName = hostComponentTemplate[1];
  let childrenTemplateIndex = 2;
  let inner = "";
  let styles = "";
  let children = "";

  if ((templateFlags & HAS_STATIC_PROPS) !== 0) {
    const staticProps = hostComponentTemplate[childrenTemplateIndex++];

    for (let i = 0, length = staticProps.length; i < length; i += 2) {
      let propName = staticProps[i];
      const staticPropValue = staticProps[i + 1];

      if (staticPropValue !== null && staticPropValue !== undefined) {
        if (propName === "className") {
          propName = "class";
        } else if (propName === "style") {
          // TODO
          continue;
        }
        inner += ` ${propName}="${staticPropValue}"`;
      }
    }
  }
  if ((templateFlags & HAS_DYNAMIC_PROPS) !== 0) {
    const dynamicProps = hostComponentTemplate[childrenTemplateIndex++];

    for (let i = 0, length = dynamicProps.length; i < length; i += 2) {
      let propName = dynamicProps[i];
      const dynamicPropValueIndex = dynamicProps[i + 1];
      const dynamicPropValue = values[dynamicPropValueIndex];

      if (dynamicPropValue !== null && dynamicPropValue !== undefined) {
        if (propName === "className") {
          propName = "class";
        } else if (propName === "style") {
          // TODO
          continue;
        }
        inner += ` ${propName}="${dynamicPropValue}"`;
      }
    }
  }
  if (state.hasCreatedMarkupForRoot === false) {
    state.hasCreatedMarkupForRoot = true;
    inner += ' data-reactroot=""';
  }
  state.lastChildWasText = false;
  if ((templateFlags & IS_VOID) !== 0) {
    return `<${tagName}${styles}${inner}/>`;
  }

  if ((templateFlags & HAS_DYNAMIC_TEXT_CONTENT) !== 0) {
    const textContentValueIndex = hostComponentTemplate[childrenTemplateIndex];
    children = escapeText(values[textContentValueIndex]);
  } else if ((templateFlags & HAS_STATIC_TEXT_CONTENT) !== 0) {
    children = hostComponentTemplate[childrenTemplateIndex];
  } else if ((templateFlags & HAS_CHILD) !== 0) {
    const child = hostComponentTemplate[childrenTemplateIndex];
    children += renderTemplateToString(child, values, true, state);
  } else if ((templateFlags & HAS_CHILDREN) !== 0) {
    const childrenTemplateNodes = hostComponentTemplate[childrenTemplateIndex];
    for (let i = 0, length = childrenTemplateNodes.length; i < length; ++i) {
      children += renderTemplateToString(childrenTemplateNodes[i], values, false, state);
    }
  }
  return `<${tagName}${styles}${inner}>${children}</${tagName}>`;
}

function renderTextTemplateToString(templateTypeAndFlags, textTemplate, values, isOnlyChild, state) {
  const templateFlags = templateTypeAndFlags & ~0x3f;
  const isStatic = (templateFlags & IS_STATIC) !== 0;
  const text = isStatic === true ? textTemplate[1] : escapeText(values[textTemplate[1]]);
  const lastChildWasText = state.lastChildWasText;

  if (isOnlyChild === false) {
    state.lastChildWasText = true;
    if (lastChildWasText === true) {
      return `<!-- -->${text}`;
    }
  }
  return text;
}

function renderMultiConditionalTemplateToString(multiConditionalTemplate, values, isOnlyChild, state) {
  const conditions = multiConditionalTemplate[1];

  for (let i = 0, length = conditions.length; i < length; i += 2) {
    const conditionValueIndexOrNull = conditions[i];

    if (conditionValueIndexOrNull === null) {
      const conditionTemplateNode = conditions[i + 1];
      return renderTemplateToString(conditionTemplateNode, values, isOnlyChild, state);
    }
    const conditionValue = values[conditionValueIndexOrNull];

    if (conditionValue) {
      const conditionTemplateNode = conditions[i + 1];
      return renderTemplateToString(conditionTemplateNode, values, isOnlyChild, state);
    }
  }
}

function renderConditionalTemplateToString(conditionalTemplate, values, isOnlyChild, state) {
  const conditionalValueIndex = conditionalTemplate[1];
  const conditionalValue = values[conditionalValueIndex];

  if (conditionalValue) {
    const consequentTemplate = conditionalTemplate[2];
    if (consequentTemplate !== null) {
      return renderTemplateToString(consequentTemplate, values, isOnlyChild, state);
    }
  } else {
    const alternateTemplate = conditionalTemplate[3];
    if (alternateTemplate !== null) {
      return renderTemplateToString(alternateTemplate, values, isOnlyChild, state);
    }
  }
  return "";
}

function renderTemplateFunctionCallTemplateToString(templateFunctionCallTemplate, values, isOnlyChild, state) {
  const functionCallTemplateNode = templateFunctionCallTemplate[1];
  const functionCallValuesIndex = templateFunctionCallTemplate[2];
  const functionCallValues = values[functionCallValuesIndex];
  return renderTemplateToString(functionCallTemplateNode, functionCallValues, isOnlyChild, state);
}

function renderTemplateToString(templateNode, values, isOnlyChild, state) {
  const templateTypeAndFlags = templateNode[0];
  const templateType = templateTypeAndFlags & 0x3f;

  switch (templateType) {
    case ROOT_COMPONENT:
      return renderFunctionComponentTemplateToString(
        true,
        templateTypeAndFlags,
        templateNode,
        values,
        isOnlyChild,
        state,
      );
    case COMPONENT:
      return renderFunctionComponentTemplateToString(
        false,
        templateTypeAndFlags,
        templateNode,
        values,
        isOnlyChild,
        state,
      );
    case HOST_COMPONENT:
      return renderHostComponentTemplateToString(templateTypeAndFlags, templateNode, values, isOnlyChild, state);
    case TEXT:
      return renderTextTemplateToString(templateTypeAndFlags, templateNode, values, isOnlyChild, state);
    case FRAGMENT:
      // return mountDOMFromFragmentTemplate(parentDOMElement, templateNode, fiber, runtimeValues);
      return null;
    case CONDITIONAL:
      return renderConditionalTemplateToString(templateNode, values, isOnlyChild, state);
    case TEMPLATE_FUNCTION_CALL:
      return renderTemplateFunctionCallTemplateToString(templateNode, values, isOnlyChild, state);
    case MULTI_CONDITIONAL:
      return renderMultiConditionalTemplateToString(templateNode, values, isOnlyChild, state);
    default:
      throw new Error("Should never happen");
  }
}

function createState(rootProps) {
  return {
    hasCreatedMarkupForRoot: false,
    lastChildWasText: false,
    rootProps,
  };
}

function renderNode(input) {
  if (input === null || input === undefined) {
    return "";
  } else if (input.$$typeof === reactElementSymbol) {
    const templateNode = input.type;
    const state = createState(input.props);
    return renderTemplateToString(templateNode, null, true, state);
  } else {
    throw new Error("renderToString() expects a ReactElement as the only argument");
  }
}

export function renderToString(node) {
  const prevDispatcher = currentDispatcher.current;
  currentDispatcher.current = Dispatcher;
  const string = renderNode(node);
  currentDispatcher.current = prevDispatcher;
  return string;
}
