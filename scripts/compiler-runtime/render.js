import { currentDispatcher } from "./index";
import { Dispatcher, callComputeFunctionWithHooks } from "./dom-dispatcher";
import {
  convertRootPropsToPropsArray,
  createOpcodeFiber,
  emptyArray,
  insertChildFiberIntoParentFiber,
  isArray,
  isReactNode,
  reactElementSymbol,
} from "./utils";

const rootStates = new Map();
const mountOpcodesToUpdateOpcodes = new Map();
const mountOpcodesToUnmountOpcodes = new Map();
const componentOpcodeCache = new Map();

// const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
// const COMMENT_NODE = 8;
// const DOCUMENT_NODE = 9;
// const DOCUMENT_FRAGMENT_NODE = 11;

const OPEN_ELEMENT = 0;
const OPEN_ELEMENT_WITH_POINTER = 1;
const OPEN_ELEMENT_DIV = 2;
const OPEN_ELEMENT_DIV_WITH_POINTER = 3;
const OPEN_ELEMENT_SPAN = 4;
const OPEN_ELEMENT_SPAN_WITH_POINTER = 5;
const OPEN_VOID_ELEMENT = 6;
const OPEN_VOID_ELEMENT_WITH_POINTER = 7;
const CLOSE_ELEMENT = 8;
const CLOSE_VOID_ELEMENT = 9;
const COMPONENT = 10;
const ROOT_STATIC_VALUE = 11;
const ROOT_DYNAMIC_VALUE = 12;
const CONDITIONAL_TEMPLATE = 13;
const MULTI_CONDITIONAL = 14;
const CONDITIONAL = 15;
const OPEN_FRAGMENT = 16;
const CLOSE_FRAGMENT = 17;
// const OPEN_CONTEXT_PROVIDER = 18;
// const CLOSE_CONTEXT_PROVIDER = 19;
// const CONTEXT_CONSUMER = 20;
const OPEN_PROP_STYLE = 21;
const CLOSE_PROP_STYLE = 22;
const TEMPLATE_FROM_FUNC_CALL = 23;
const REACT_NODE_TEMPLATE_FROM_FUNC_CALL = 24;
const REF_COMPONENT = 25;
// const LOGICAL_OR = 26;
// const LOGICAL_AND = 27;
const ELEMENT_STATIC_CHILD_VALUE = 28;
const ELEMENT_STATIC_CHILDREN_VALUE = 29;
const ELEMENT_DYNAMIC_CHILD_VALUE = 30;
const ELEMENT_DYNAMIC_CHILDREN_VALUE = 31;
// const ELEMENT_DYNAMIC_CHILD_TEMPLATE_FROM_FUNC_CALL = 32;
const ELEMENT_DYNAMIC_CHILDREN_TEMPLATE_FROM_FUNC_CALL = 33;
const ELEMENT_DYNAMIC_CHILDREN_ARRAY_MAP_TEMPLATE = 34;
const ELEMENT_DYNAMIC_CHILD_REACT_NODE_TEMPLATE = 35;
const ELEMENT_DYNAMIC_CHILDREN_REACT_NODE_TEMPLATE = 36;
// const ELEMENT_DYNAMIC_FUNCTION_CHILD = 37;
const STATIC_PROP = 38;
const DYNAMIC_PROP = 39;
const STATIC_PROP_CLASS_NAME = 40;
const DYNAMIC_PROP_CLASS_NAME = 41;
const STATIC_PROP_VALUE = 42;
// const DYNAMIC_PROP_VALUE = 43;
const STATIC_PROP_STYLE = 44;
const DYNAMIC_PROP_STYLE = 45;
const STATIC_PROP_UNITLESS_STYLE = 46;
// const DYNAMIC_PROP_UNITLESS_STYLE = 47;
const DYNAMIC_PROP_REF = 48;

const PropFlagPartialTemplate = 1;
const PropFlagReactEvent = 1 << 1; // starts with on
const PropFlagReactCapturedEvent = 1 << 2;

const EventFlagBubbles = 1;
const EventFlagTwoPhase = 1 << 1;

const hostNodeEventListeners = new WeakMap();
const hostNodeRegisteredEventCallbacks = new WeakMap();

function createPlaceholderNode() {
  return document.createTextNode("");
}

function createElement(tagName) {
  return document.createElement(tagName);
}

function createTextNode(text) {
  return document.createTextNode(text);
}

function getEventTarget(nativeEvent) {
  // Fallback to nativeEvent.srcElement for IE9
  // https://github.com/facebook/react/issues/12506
  let target = nativeEvent.target || nativeEvent.srcElement || window;

  // Normalize SVG <use> element events #4963
  if (target.correspondingUseElement) {
    target = target.correspondingUseElement;
  }

  // Safari may fire events on text nodes (Node.TEXT_NODE is 3).
  // @see http://www.quirksmode.org/js/events_properties.html
  return target.nodeType === TEXT_NODE ? target.parentNode : target;
}

function listenToEvent(state, eventName, eventInformation) {
  const rootHostNode = state.fiber.hostNode;
  let registeredEvents = hostNodeEventListeners.get(rootHostNode);

  if (registeredEvents === undefined) {
    registeredEvents = new Map();
    hostNodeEventListeners.set(rootHostNode, registeredEvents);
  }
  rootHostNode.addEventListener(
    eventName,
    proxyEvent.bind(null, eventName, eventInformation),
    eventInformation & EventFlagBubbles,
  );
}

function proxyEvent(eventName, eventInformation, nativeEvent) {
  const eventTarget = getEventTarget(nativeEvent);
  const path = [];
  let domNode = eventTarget;

  while (domNode !== null) {
    if (hostNodeRegisteredEventCallbacks.has(domNode)) {
      path.push(domNode);
    }
    domNode = domNode.parentNode;
  }
  const pathLength = path.length;

  if (pathLength > 0 && eventInformation & EventFlagTwoPhase) {
    let i;
    // eslint-disable-next-line space-in-parens
    for (i = pathLength; i-- > 0; ) {
      dispatchEventCallback(eventName + "-captured", path[i], nativeEvent);
    }
    for (i = 0; i < pathLength; i++) {
      dispatchEventCallback(eventName, path[i], nativeEvent);
    }
  }
}

function dispatchEventCallback(dispatchEventName, domNode, nativeEvent) {
  const registeredEventCallbacks = hostNodeRegisteredEventCallbacks.get(domNode);
  const eventCallback = registeredEventCallbacks.get(dispatchEventName);
  if (eventCallback !== undefined) {
    eventCallback(nativeEvent);
  }
}

function registerEventCallbackForHostNode(hostNode, eventName, eventCallback, capturedEvent) {
  let registeredEventCallbacks = hostNodeRegisteredEventCallbacks.get(hostNode);
  if (registeredEventCallbacks === undefined) {
    registeredEventCallbacks = new Map();
    hostNodeRegisteredEventCallbacks.set(hostNode, registeredEventCallbacks);
  }
  registeredEventCallbacks.set(capturedEvent ? eventName + "-captured" : eventName, eventCallback);
}

function removeChild(parent, child) {
  if (isArray(child)) {
    for (let i = 0, length = child.length; i < length; i++) {
      removeChild(parent, child[i]);
    }
  } else {
    parent.removeChild(child);
  }
}

function replaceChild(originalNode, replaceNode) {
  originalNode.parentNode.replaceChild(replaceNode, originalNode);
}

function appendChild(parentElementOrFragment, element) {
  if (isArray(parentElementOrFragment)) {
    parentElementOrFragment.push(element);
  } else if (isArray(element)) {
    for (let i = 0, length = element.length; i < length; i++) {
      appendChild(parentElementOrFragment, element[i]);
    }
  } else {
    parentElementOrFragment.appendChild(element);
  }
}

function callComputeFunctionWithArray(computeFunction, arr) {
  if (arr === null) {
    return computeFunction();
  }
  switch (arr.length) {
    case 0:
      return computeFunction();
    case 1:
      return computeFunction(arr[0]);
    case 2:
      return computeFunction(arr[0], arr[1]);
    case 3:
      return computeFunction(arr[0], arr[1], arr[2]);
    case 4:
      return computeFunction(arr[0], arr[1], arr[2], arr[3]);
    case 7:
      return computeFunction(arr[0], arr[1], arr[2], arr[3], arr[4], arr[5], arr[6]);
    default:
      return computeFunction.apply(null, arr);
  }
}

function openElement(elem, state, currentFiber) {
  const currentHostNode = state.currentHostNode;
  if (currentFiber.hostNode === null) {
    currentFiber.hostNode = elem;
  }
  if (currentHostNode !== null) {
    const stackIndex = state.currentHostNodeStackIndex++;
    state.currentHostNodeStack[stackIndex] = state.currentHostNode;
  }
  state.currentHostNode = elem;
}

function isEmptyTextContent(textContent) {
  return textContent === null || textContent === undefined || textContent === "" || typeof textContent === "boolean";
}

function joinArrayTextContent(textContent) {
  let joinedTextContent = "";
  const childrenLength = textContent.length;
  for (let i = 0; i < childrenLength; ++i) {
    const childText = textContent[i];
    if (childText !== null && childText !== undefined && typeof childText !== "boolean") {
      joinedTextContent += childText;
    }
  }

  return joinedTextContent;
}

function renderMountReactNode(node, state, workInProgress) {
  if (node === null || node === undefined || typeof node === "boolean") {
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    // TODO
  } else if (isReactNode(node)) {
    const templateOpcodes = node.t;
    const templateRuntimeValues = node.v;
    return renderMountOpcodes(templateOpcodes, templateRuntimeValues, state, workInProgress);
  } else if (isArray(node)) {
    const arr = [];
    for (let i = 0, length = node.length; i < length; ++i) {
      const elementNode = node[i];
      const hostNode = renderMountReactNode(elementNode, state, workInProgress);
      if (hostNode !== undefined) {
        arr.push(hostNode);
      }
    }
    return arr;
  }
}

function renderMountOpcodes(mountOpcodes, runtimeValues, state, workInProgress) {
  const opcodesLength = mountOpcodes.length;
  let updateOpcodes = mountOpcodesToUpdateOpcodes.get(mountOpcodes);
  let unmountOpcodes = mountOpcodesToUnmountOpcodes.get(mountOpcodes);
  let topHostNode;
  const shouldCreateOpcodes = updateOpcodes === undefined;
  const values = workInProgress === null ? null : workInProgress.values;

  if (shouldCreateOpcodes === true) {
    updateOpcodes = [];
    unmountOpcodes = [];
    mountOpcodesToUpdateOpcodes.set(mountOpcodes, updateOpcodes);
    mountOpcodesToUnmountOpcodes.set(mountOpcodes, unmountOpcodes);
  }
  let index = 0;

  // Render opcodes from the opcode jump-table
  while (index < opcodesLength) {
    const opcode = mountOpcodes[index];

    switch (opcode) {
      case REF_COMPONENT: {
        const componentOpcodesFunction = mountOpcodes[++index];
        const propsValuePointerOrValue = mountOpcodes[++index];
        let componentMountOpcodes = componentOpcodeCache.get(componentOpcodesFunction);

        if (componentMountOpcodes === undefined) {
          componentMountOpcodes = componentOpcodesFunction();
          componentOpcodeCache.set(componentOpcodesFunction, componentMountOpcodes);
        } else {
          componentMountOpcodes = componentOpcodeCache.get(componentOpcodesFunction);
        }
        let props = null;
        if (isArray(propsValuePointerOrValue)) {
          props = propsValuePointerOrValue;
        } else if (propsValuePointerOrValue !== null) {
          props = runtimeValues[propsValuePointerOrValue];
        }
        state.props = props;
        topHostNode = renderMountOpcodes(componentMountOpcodes, runtimeValues, state, workInProgress);
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(componentMountOpcodes, propsValuePointerOrValue);
        }
        break;
      }
      case STATIC_PROP_CLASS_NAME: {
        const staticClassName = mountOpcodes[++index];
        state.currentHostNode.className = staticClassName;
        break;
      }
      case DYNAMIC_PROP_CLASS_NAME: {
        const propInformation = mountOpcodes[++index];
        const dynamicClassNamePointer = mountOpcodes[++index];
        const dynamicClassName = runtimeValues[dynamicClassNamePointer];

        if (propInformation & PropFlagPartialTemplate) {
          throw new Error("TODO DYNAMIC_PROP_CLASS_NAME");
        } else {
          state.currentHostNode.className = dynamicClassName;
        }
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(DYNAMIC_PROP_CLASS_NAME, propInformation, dynamicClassNamePointer);
        }
        break;
      }
      case STATIC_PROP: {
        const propName = mountOpcodes[++index];
        const staticPropValue = mountOpcodes[++index];
        const currentHostNode = state.currentHostNode;
        if (propName === "id") {
          currentHostNode.id = staticPropValue;
        } else {
          currentHostNode.setAttribute(propName, staticPropValue);
        }
        break;
      }
      case DYNAMIC_PROP: {
        const propName = mountOpcodes[++index];
        const propInformation = mountOpcodes[++index];
        let eventInformation;

        if (propInformation & PropFlagReactEvent) {
          eventInformation = mountOpcodes[++index];
        }
        const dynamicPropValuePointer = mountOpcodes[++index];
        const dynamicPropValue = runtimeValues[dynamicPropValuePointer];

        if (propInformation & PropFlagPartialTemplate) {
          throw new Error("TODO DYNAMIC_PROP");
        } else if (eventInformation !== undefined) {
          listenToEvent(state, propName, eventInformation);
          registerEventCallbackForHostNode(
            state.currentHostNode,
            propName,
            dynamicPropValue,
            propInformation & PropFlagReactCapturedEvent,
          );
        } else if (dynamicPropValue !== null && dynamicPropValue !== undefined) {
          state.currentHostNode.setAttribute(propName, dynamicPropValue);
        }
        break;
      }
      case STATIC_PROP_VALUE: {
        const staticValueProp = mountOpcodes[++index];
        if (typeof staticValueProp === "string") {
          state.currentHostNode.value = staticValueProp;
        } else {
          state.currentHostNode.setAttribute("value", staticValueProp);
        }
        break;
      }
      case ELEMENT_STATIC_CHILD_VALUE: {
        const staticTextChild = mountOpcodes[++index];
        const textNode = createTextNode(staticTextChild);
        const currentHostNode = state.currentHostNode;

        appendChild(currentHostNode, textNode);
        break;
      }
      case ELEMENT_STATIC_CHILDREN_VALUE: {
        const staticTextContent = mountOpcodes[++index];
        state.currentHostNode.textContent = staticTextContent;
        break;
      }
      case ELEMENT_DYNAMIC_CHILD_VALUE: {
        const dynamicTextChildPointer = mountOpcodes[++index];
        const hostNodeValuePointer = mountOpcodes[++index];
        let dynamicTextChild = runtimeValues[dynamicTextChildPointer];
        let textNode;

        if (typeof dynamicTextChild !== "string" && typeof dynamicTextChild !== "number") {
          if (isEmptyTextContent(dynamicTextChild)) {
            textNode = createPlaceholderNode();
          } else if (isArray(dynamicTextChild)) {
            dynamicTextChild = joinArrayTextContent(dynamicTextChild);
          }
        }
        if (textNode === undefined) {
          textNode = createTextNode(dynamicTextChild);
        }
        const currentHostNode = state.currentHostNode;
        values[hostNodeValuePointer] = textNode;
        appendChild(currentHostNode, textNode);
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(ELEMENT_DYNAMIC_CHILDREN_VALUE, dynamicTextChildPointer, hostNodeValuePointer);
        }
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_VALUE: {
        const dynamicTextContentPointer = mountOpcodes[++index];
        const hostNodeValuePointer = mountOpcodes[++index];
        const currentHostNode = state.currentHostNode;
        let dynamicTextContent = runtimeValues[dynamicTextContentPointer];
        let textNode;

        if (typeof dynamicTextContent !== "string" && typeof dynamicTextContent !== "number") {
          if (isEmptyTextContent(dynamicTextContent)) {
            textNode = createPlaceholderNode();
          } else if (isArray(dynamicTextContent)) {
            dynamicTextContent = joinArrayTextContent(dynamicTextContent);
          }
        }
        if (textNode === undefined) {
          currentHostNode.textContent = dynamicTextContent;
          textNode = currentHostNode.firstChild;
        }
        values[hostNodeValuePointer] = textNode;
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(ELEMENT_DYNAMIC_CHILDREN_VALUE, dynamicTextContentPointer, hostNodeValuePointer);
        }
        break;
      }
      case ELEMENT_DYNAMIC_CHILD_REACT_NODE_TEMPLATE: {
        const reactNodeOrArrayPointer = mountOpcodes[++index];
        const hostNodeValuePointer = mountOpcodes[++index];
        const reactNodeOrArray = runtimeValues[reactNodeOrArrayPointer];
        const hostNode = (topHostNode = renderMountReactNode(reactNodeOrArray, state, workInProgress));
        values[hostNodeValuePointer] = hostNode;
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_REACT_NODE_TEMPLATE: {
        const reactNodeOrArrayPointer = mountOpcodes[++index];
        const hostNodeValuePointer = mountOpcodes[++index];
        const reactNodeOrArray = runtimeValues[reactNodeOrArrayPointer];
        state.lastChildWasTextNode = false;
        const hostNode = (topHostNode = renderMountReactNode(reactNodeOrArray, state, workInProgress));
        values[hostNodeValuePointer] = hostNode;
        break;
      }
      case OPEN_ELEMENT_DIV: {
        const elem = createElement("div");
        openElement(elem, state, workInProgress);
        break;
      }
      case OPEN_ELEMENT_SPAN: {
        const elem = createElement("span");
        openElement(elem, state, workInProgress);
        break;
      }
      case OPEN_ELEMENT: {
        const elementTag = mountOpcodes[++index];
        const elem = createElement(elementTag);
        openElement(elem, state, workInProgress);
        break;
      }
      case OPEN_ELEMENT_DIV_WITH_POINTER: {
        const elem = createElement("div");
        const elementValuePointer = mountOpcodes[++index];
        openElement(elem, state, workInProgress);
        values[elementValuePointer] = elem;
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(OPEN_ELEMENT_DIV_WITH_POINTER, elementValuePointer);
        }
        break;
      }
      case OPEN_ELEMENT_SPAN_WITH_POINTER: {
        const elem = createElement("span");
        const elementValuePointer = mountOpcodes[++index];
        openElement(elem, state, workInProgress);
        values[elementValuePointer] = elem;
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(OPEN_ELEMENT_SPAN_WITH_POINTER, elementValuePointer);
        }
        break;
      }
      case OPEN_ELEMENT_WITH_POINTER: {
        const elementTag = mountOpcodes[++index];
        const elementValuePointer = mountOpcodes[++index];
        const elem = createElement(elementTag);
        openElement(elem, state, workInProgress);
        values[elementValuePointer] = elem;
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(OPEN_ELEMENT_WITH_POINTER, elementValuePointer);
        }
        break;
      }
      case CLOSE_FRAGMENT:
      case CLOSE_VOID_ELEMENT:
      case CLOSE_ELEMENT: {
        let stackIndex = state.currentHostNodeStackIndex;
        let currentHostNode = state.currentHostNode;
        if (stackIndex === 0) {
          state.currentHostNode = null;
        } else {
          stackIndex = --state.currentHostNodeStackIndex;
          const parent = state.currentHostNodeStack[stackIndex];
          state.currentHostNodeStack[stackIndex] = null;
          appendChild(parent, currentHostNode);
          state.currentHostNode = currentHostNode = parent;
        }
        topHostNode = currentHostNode;
        break;
      }
      case OPEN_VOID_ELEMENT: {
        const elementTag = mountOpcodes[++index];
        const elem = createElement(elementTag);
        openElement(elem, state, workInProgress);
        break;
      }
      case OPEN_VOID_ELEMENT_WITH_POINTER: {
        const elementTag = mountOpcodes[++index];
        const elementValuePointer = mountOpcodes[++index];
        const elem = createElement(elementTag);
        openElement(elem, state, workInProgress);
        values[elementValuePointer] = elem;
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(OPEN_VOID_ELEMENT_WITH_POINTER, elementValuePointer);
        }
        break;
      }
      case OPEN_FRAGMENT: {
        const hostNode = [];
        openElement(hostNode, state, workInProgress);
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_TEMPLATE_FROM_FUNC_CALL: {
        const templateOpcodes = mountOpcodes[++index];
        const computeValuesPointer = mountOpcodes[++index];
        const hostNodeValuePointer = mountOpcodes[++index];
        const computeValues = runtimeValues[computeValuesPointer];
        let hostNode;
        if (computeValues !== null) {
          hostNode = renderMountOpcodes(templateOpcodes, computeValues, state, workInProgress);
        } else {
          hostNode = createPlaceholderNode();
        }
        values[hostNodeValuePointer] = hostNode;
        break;
      }
      case STATIC_PROP_STYLE: {
        const styleName = mountOpcodes[++index];
        let styleValue = mountOpcodes[++index];

        if (styleValue == null || styleValue === undefined) {
          break;
        }
        if (typeof styleValue === "number") {
          styleValue = `${styleValue}px`;
        }
        state.currentHostNode.style.setProperty(styleName, styleValue);
        break;
      }
      case DYNAMIC_PROP_STYLE: {
        const styleName = mountOpcodes[++index];
        const styleValuePointer = mountOpcodes[++index];
        let styleValue = runtimeValues[styleValuePointer];

        if (styleValue == null || styleValue === undefined) {
          break;
        }
        if (typeof styleValue === "number") {
          styleValue = `${styleValue}px`;
        }
        state.currentHostNode.style.setProperty(styleName, styleValue);
        break;
      }
      case STATIC_PROP_UNITLESS_STYLE: {
        const styleName = mountOpcodes[++index];
        const styleValue = mountOpcodes[++index];

        if (styleValue == null || styleValue === undefined) {
          break;
        }
        state.currentHostNode.style.setProperty(styleName, styleValue);
        break;
      }
      case CONDITIONAL: {
        const hostNodeValuePointer = mountOpcodes[++index];
        const conditionValuePointer = mountOpcodes[++index];
        const conditionValue = runtimeValues[conditionValuePointer];
        const consequentMountOpcodes = mountOpcodes[++index];
        const alternateMountOpcodes = mountOpcodes[++index];
        let hostNode;

        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(
            CONDITIONAL,
            hostNodeValuePointer,
            conditionValuePointer,
            consequentMountOpcodes,
            alternateMountOpcodes,
          );
        }

        if (conditionValue) {
          if (consequentMountOpcodes !== 0) {
            hostNode = renderMountOpcodes(consequentMountOpcodes, runtimeValues, state, workInProgress);
          }
        } else {
          if (alternateMountOpcodes !== 0) {
            hostNode = renderMountOpcodes(alternateMountOpcodes, runtimeValues, state, workInProgress);
          }
        }
        topHostNode = values[hostNodeValuePointer] = hostNode;
        break;
      }
      case MULTI_CONDITIONAL: {
        const conditionalSize = mountOpcodes[++index];
        const hostNodeValuePointer = mountOpcodes[++index];
        const caseValuePointer = mountOpcodes[++index];
        const startingIndex = index;
        const conditionalDefaultIndex = conditionalSize - 1;
        if (shouldCreateOpcodes === true) {
          const sliceFrom = startingIndex + 1;
          const sliceTo = sliceFrom + (conditionalSize - 1) * 2 + 1;
          updateOpcodes.push(
            MULTI_CONDITIONAL,
            conditionalSize,
            hostNodeValuePointer,
            caseValuePointer,
            ...mountOpcodes.slice(sliceFrom, sliceTo),
          );
        }
        let hostNode;
        let conditionalIndex = 0;
        for (; conditionalIndex < conditionalSize; conditionalIndex++) {
          if (conditionalIndex === conditionalDefaultIndex) {
            const defaultCaseMountOpcodes = mountOpcodes[++index];

            if (defaultCaseMountOpcodes !== null) {
              hostNode = renderMountOpcodes(defaultCaseMountOpcodes, runtimeValues, state, workInProgress);
            }
          } else {
            const caseConditionPointer = mountOpcodes[++index];
            const caseConditionValue = runtimeValues[caseConditionPointer];

            if (caseConditionValue === true) {
              const caseMountOpcodes = mountOpcodes[++index];
              if (caseMountOpcodes !== null) {
                hostNode = renderMountOpcodes(caseMountOpcodes, runtimeValues, state, workInProgress);
              }
              break;
            }
            ++index;
          }
        }
        values[caseValuePointer] = conditionalIndex - 1;
        topHostNode = values[hostNodeValuePointer] = hostNode;
        index = startingIndex + (conditionalSize - 1) * 2 + 1;
        break;
      }
      case TEMPLATE_FROM_FUNC_CALL: {
        const templateMountOpcodes = mountOpcodes[++index];
        const computeValuesPointer = mountOpcodes[++index];
        const computeValues = runtimeValues[computeValuesPointer];
        topHostNode = renderMountOpcodes(templateMountOpcodes, computeValues, state, workInProgress);
        break;
      }
      case REACT_NODE_TEMPLATE_FROM_FUNC_CALL: {
        const reactNodePointer = mountOpcodes[++index];
        const reactNode = runtimeValues[reactNodePointer];
        topHostNode = renderMountReactNode(reactNode, state, workInProgress);
        break;
      }
      case ELEMENT_DYNAMIC_CHILDREN_ARRAY_MAP_TEMPLATE: {
        const arrayPointer = mountOpcodes[++index];
        const arrayMapOpcodes = mountOpcodes[++index];
        const arrayMapComputeFunctionPointer = mountOpcodes[++index];
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
          renderMountOpcodes(arrayMapOpcodes, templateRuntimeValues, state, workInProgress);
        }
        break;
      }
      case CONDITIONAL_TEMPLATE: {
        const hostNodeValuePointer = mountOpcodes[++index];
        const branchMountOpcodesPointer = mountOpcodes[++index];
        let templateRuntimeValues = runtimeValues;
        let templateValuesPointerIndex;
        let hostNode;
        let templateMountOpcodes;

        let conditionBranchOpcodes;
        if (hostNode === undefined) {
          conditionBranchOpcodes = mountOpcodes[++index];
          const conditionBranchOpcodesLength = conditionBranchOpcodes.length;
          const conditionBranchToUseKey = templateRuntimeValues[0];
          let branchIndex = 0;

          while (branchIndex < conditionBranchOpcodesLength) {
            const branchConditionKey = conditionBranchOpcodes[branchIndex];
            if (branchConditionKey === conditionBranchToUseKey) {
              templateMountOpcodes = conditionBranchOpcodes[++branchIndex];
              hostNode = renderMountOpcodes(templateMountOpcodes, templateRuntimeValues, state, workInProgress);
              break;
            }
            branchIndex += 2;
          }
        }
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(CONDITIONAL_TEMPLATE, hostNodeValuePointer, branchMountOpcodesPointer);
          if (templateValuesPointerIndex !== undefined) {
            updateOpcodes.push(templateValuesPointerIndex);
          }
          if (conditionBranchOpcodes === undefined) {
            conditionBranchOpcodes = mountOpcodes[++index];
          }
          updateOpcodes.push(conditionBranchOpcodes);
        }
        values[branchMountOpcodesPointer] = templateMountOpcodes;
        topHostNode = values[hostNodeValuePointer] = hostNode;
        break;
      }
      case COMPONENT: {
        const usesHooks = mountOpcodes[++index];
        let rootPropsShape;
        let props;

        // Handle root component props
        if (workInProgress === null) {
          rootPropsShape = mountOpcodes[++index];
          props = convertRootPropsToPropsArray(state.rootPropsObject, rootPropsShape);
        } else {
          props = state.props;
        }
        const computeFunction = mountOpcodes[++index];
        const componentValues = [null];
        const componentFiber = createOpcodeFiber(null, props, componentValues);
        let componentRuntimeValues = runtimeValues;

        if (computeFunction !== 0) {
          if (usesHooks === true) {
            componentRuntimeValues = callComputeFunctionWithHooks(componentFiber, computeFunction, props);
          } else {
            componentRuntimeValues = callComputeFunctionWithArray(computeFunction, props);
          }
          componentValues[0] = componentRuntimeValues;
        }
        const componentMountOpcodes = mountOpcodes[++index];
        if (shouldCreateOpcodes === true) {
          updateOpcodes.push(COMPONENT, usesHooks, componentMountOpcodes);
          if (rootPropsShape !== undefined) {
            updateOpcodes.push(rootPropsShape);
          }
          unmountOpcodes.push(COMPONENT, usesHooks, componentMountOpcodes);
        }
        if (workInProgress === null) {
          // Root
          state.fiber = componentFiber;
        } else {
          insertChildFiberIntoParentFiber(workInProgress, componentFiber);
        }
        let hostNode;
        if (componentRuntimeValues !== null) {
          hostNode = renderMountOpcodes(componentMountOpcodes, componentRuntimeValues, state, componentFiber);
        } else {
          hostNode = createPlaceholderNode();
          componentFiber.hostNode = hostNode;
        }
        if (workInProgress !== null && workInProgress.hostNode === null) {
          workInProgress.hostNode = componentFiber.hostNode;
        }
        return hostNode;
      }
      case ROOT_DYNAMIC_VALUE: {
        const dynamicValuePointer = mountOpcodes[++index];
        let value = runtimeValues[dynamicValuePointer];
        if (isReactNode(value)) {
          return renderMountReactNode(value, state, workInProgress);
        } else {
          // TODO
        }
        return null;
      }
      case ROOT_STATIC_VALUE: {
        const staticValue = mountOpcodes[++index];
        let hostNode;
        if (staticValue === null) {
          hostNode = createPlaceholderNode();
        } else if (typeof staticValue === "string") {
          hostNode = createTextNode(staticValue);
        } else {
          throw new Error("TODO");
        }
        return hostNode;
      }
      case OPEN_PROP_STYLE:
      case CLOSE_PROP_STYLE:
        break;
      case DYNAMIC_PROP_REF:
      default:
        index += 3;
        continue;
    }
    ++index;
  }
  return topHostNode;
}

function renderUpdateOpcodes(updateOpcodes, previousRuntimeValues, nextRuntimeValues, state, workInProgress) {
  const opcodesLength = updateOpcodes.length;
  const values = workInProgress === null ? null : workInProgress.values;
  let index = 0;

  // Render opcodes from the opcode jump-table
  while (index < opcodesLength) {
    const opcode = updateOpcodes[index];

    switch (opcode) {
      case REF_COMPONENT: {
        const componentMountOpcodes = updateOpcodes[++index];
        const componentUpdateOpcodes = mountOpcodesToUpdateOpcodes.get(componentMountOpcodes);
        const propsArrayValuePointerOrValue = updateOpcodes[++index];

        let propsArrayValue = null;
        if (typeof propsArrayValuePointerOrValue === "number") {
          propsArrayValue = nextRuntimeValues[propsArrayValuePointerOrValue];
        } else if (isArray(propsArrayValuePointerOrValue)) {
          propsArrayValue = propsArrayValuePointerOrValue;
        }
        state.propsArray = propsArrayValue;
        renderUpdateOpcodes(componentUpdateOpcodes, previousRuntimeValues, nextRuntimeValues, state, workInProgress);
        break;
      }
      case ELEMENT_DYNAMIC_CHILD_VALUE:
      case ELEMENT_DYNAMIC_CHILDREN_VALUE: {
        const dynamicTextContentPointer = updateOpcodes[++index];
        const hostNodeValuePointer = updateOpcodes[++index];
        const previousDynamicTextContent = previousRuntimeValues[dynamicTextContentPointer];
        const nextDynamicTextContent = nextRuntimeValues[dynamicTextContentPointer];
        const textNode = values[hostNodeValuePointer];

        if (previousDynamicTextContent !== nextDynamicTextContent) {
          textNode.nodeValue = nextDynamicTextContent;
        }
        break;
      }
      case DYNAMIC_PROP_CLASS_NAME: {
        const propInformation = updateOpcodes[++index];
        const dynamicClassNamePointer = updateOpcodes[++index];
        const previousDynamicClassName = previousRuntimeValues[dynamicClassNamePointer];
        const nextDynamicClassName = nextRuntimeValues[dynamicClassNamePointer];

        if (previousDynamicClassName !== nextDynamicClassName) {
          if (propInformation & PropFlagPartialTemplate) {
            throw new Error("TODO DYNAMIC_PROP_CLASS_NAME");
          } else {
            state.currentHostNode.className = nextDynamicClassName;
          }
        }
        break;
      }
      case OPEN_ELEMENT_WITH_POINTER:
      case OPEN_VOID_ELEMENT_WITH_POINTER:
      case OPEN_ELEMENT_DIV_WITH_POINTER:
      case OPEN_ELEMENT_SPAN_WITH_POINTER: {
        const elementValuePointer = updateOpcodes[++index];
        state.currentHostNode = values[elementValuePointer];
        break;
      }
      case CONDITIONAL: {
        const hostNodeValuePointer = updateOpcodes[++index];
        const conditionValuePointer = updateOpcodes[++index];
        const previousConditionValue = previousRuntimeValues[conditionValuePointer];
        const nextConditionValue = nextRuntimeValues[conditionValuePointer];
        const consequentMountOpcodes = updateOpcodes[++index];
        const alternateMountOpcodes = updateOpcodes[++index];
        const shouldUpdate = previousConditionValue === nextConditionValue;
        let nextHostNode;

        if (nextConditionValue) {
          if (consequentMountOpcodes !== null) {
            if (shouldUpdate) {
              // debugger;
            } else {
              if (alternateMountOpcodes !== null) {
                let alternateUnmountOpcodes = mountOpcodesToUnmountOpcodes.get(alternateMountOpcodes);
                renderUnmountOpcodes(alternateUnmountOpcodes, state, workInProgress, true);
              }
              nextHostNode = renderMountOpcodes(consequentMountOpcodes, nextRuntimeValues, state, workInProgress);
            }
          }
        } else {
          if (alternateMountOpcodes !== null) {
            if (shouldUpdate) {
              // debugger;
            } else {
              if (consequentMountOpcodes !== null) {
                let consequentUnmountOpcodes = mountOpcodesToUnmountOpcodes.get(consequentMountOpcodes);
                renderUnmountOpcodes(consequentUnmountOpcodes, state, workInProgress, true);
              }
              nextHostNode = renderMountOpcodes(alternateMountOpcodes, nextRuntimeValues, state, workInProgress);
            }
          }
        }
        if (nextHostNode !== undefined) {
          const previousHostNode = values[hostNodeValuePointer];
          replaceChild(previousHostNode, nextHostNode);
          values[hostNodeValuePointer] = nextHostNode;
        }
        break;
      }
      case MULTI_CONDITIONAL: {
        const conditionalSize = updateOpcodes[++index];
        const hostNodeValuePointer = updateOpcodes[++index];
        const caseValuePointer = updateOpcodes[++index];
        const startingIndex = index;
        const conditionalDefaultIndex = conditionalSize - 1;
        const previousConditionalIndex = values[caseValuePointer];
        let caseHasChanged = false;
        let nextHostNode;

        for (let conditionalIndex = 0; conditionalIndex < conditionalSize; ++conditionalIndex) {
          if (conditionalIndex === conditionalDefaultIndex) {
            const defaultCaseMountOpcodes = updateOpcodes[++index];

            if (previousConditionalIndex !== conditionalIndex) {
              caseHasChanged = true;
            }
            if (defaultCaseMountOpcodes !== null) {
              if (caseHasChanged === true) {
                nextHostNode = renderMountOpcodes(defaultCaseMountOpcodes, nextRuntimeValues, state, workInProgress);
              } else {
                const defaultCaseUpdateOpcodes = mountOpcodesToUpdateOpcodes.get(defaultCaseMountOpcodes);
                renderUpdateOpcodes(
                  defaultCaseUpdateOpcodes,
                  previousRuntimeValues,
                  nextRuntimeValues,
                  state,
                  workInProgress,
                );
              }
            }
          } else {
            const caseConditionPointer = updateOpcodes[++index];
            const caseConditionValue = nextRuntimeValues[caseConditionPointer];

            if (caseConditionValue === true) {
              const caseMountOpcodes = updateOpcodes[++index];
              if (previousConditionalIndex !== conditionalIndex) {
                caseHasChanged = true;
              }
              if (caseMountOpcodes !== null) {
                if (caseHasChanged === true) {
                  nextHostNode = renderMountOpcodes(caseMountOpcodes, nextRuntimeValues, state, workInProgress);
                } else {
                  const caseUpdateOpcodes = mountOpcodesToUpdateOpcodes.get(caseMountOpcodes);
                  renderUpdateOpcodes(
                    caseUpdateOpcodes,
                    previousRuntimeValues,
                    nextRuntimeValues,
                    state,
                    workInProgress,
                  );
                }
              }
              break;
            }
            ++index;
          }
        }
        if (caseHasChanged === true) {
          const previousMountOpcodesPointer =
            previousConditionalIndex === conditionalDefaultIndex
              ? startingIndex + 1 + previousConditionalIndex * 2
              : startingIndex + 2 + previousConditionalIndex * 2;
          const previousCaseMountOpcodes = updateOpcodes[previousMountOpcodesPointer];
          const previousCaseUnmountOpcodes = mountOpcodesToUnmountOpcodes.get(previousCaseMountOpcodes);
          renderUnmountOpcodes(previousCaseUnmountOpcodes, state, workInProgress, true);
        }
        index = startingIndex + (conditionalSize - 1) * 2 + 1;
        if (nextHostNode !== undefined) {
          const previousHostNode = values[hostNodeValuePointer];
          replaceChild(previousHostNode, nextHostNode);
          values[hostNodeValuePointer] = nextHostNode;
        }
        break;
      }
      // case UNCONDITIONAL_TEMPLATE: {
      //   const templateMountOpcodes = updateOpcodes[++index];
      //   const templateUpdateOpcodes = mountOpcodesToUpdateOpcodes.get(templateMountOpcodes);
      //   const computeFunction = updateOpcodes[++index];
      //   let previousTemplateRuntimeValues = previousRuntimeValues;
      //   let nextTemplateRuntimeValues = nextRuntimeValues;
      //   if (computeFunction !== 0) {
      //     const templateValuesPointerIndex = updateOpcodes[++index];
      //     nextTemplateRuntimeValues = callComputeFunctionWithArray(computeFunction, state.currentComponent.props);
      //     previousTemplateRuntimeValues = values[templateValuesPointerIndex];
      //     values[templateValuesPointerIndex] = nextRuntimeValues;
      //   }
      //   renderUpdateOpcodes(
      //     templateUpdateOpcodes,
      //     previousTemplateRuntimeValues,
      //     nextTemplateRuntimeValues,
      //     state,
      //     workInProgress,
      //   );
      //   return;
      // }
      case CONDITIONAL_TEMPLATE: {
        const hostNodeValuePointer = updateOpcodes[++index];
        const branchMountOpcodesPointer = updateOpcodes[++index];
        const computeFunction = updateOpcodes[++index];
        let previousTemplateRuntimeValues = previousRuntimeValues;
        let nextTemplateRuntimeValues = nextRuntimeValues;
        let templateValuesPointerIndex;
        let nextHostNode;
        let branchHasChanged = false;
        let nextTemplateMountOpcodes;

        if (computeFunction !== 0) {
          templateValuesPointerIndex = updateOpcodes[++index];
          nextTemplateRuntimeValues = callComputeFunctionWithArray(computeFunction, state.currentComponent.props);
          previousTemplateRuntimeValues = values[templateValuesPointerIndex];
          values[templateValuesPointerIndex] = nextTemplateRuntimeValues;
          if (nextTemplateRuntimeValues === null && previousTemplateRuntimeValues !== null) {
            branchHasChanged = true;
            nextTemplateMountOpcodes = null;
            nextHostNode = createPlaceholderNode();
          }
        }
        if (nextHostNode === undefined) {
          const conditionBranchOpcodes = updateOpcodes[++index];
          const conditionBranchOpcodesLength = conditionBranchOpcodes.length;
          const previousConditionBranchToUseKey =
            previousTemplateRuntimeValues === null ? null : previousTemplateRuntimeValues[0];
          const nextConditionBranchToUseKey = nextTemplateRuntimeValues[0];
          let branchIndex = 0;

          while (branchIndex < conditionBranchOpcodesLength) {
            const branchConditionKey = conditionBranchOpcodes[branchIndex];
            if (branchConditionKey === nextConditionBranchToUseKey) {
              if (branchConditionKey !== previousConditionBranchToUseKey) {
                branchHasChanged = true;
              }
              nextTemplateMountOpcodes = conditionBranchOpcodes[++branchIndex];
              if (branchHasChanged) {
                nextHostNode = renderMountOpcodes(
                  nextTemplateMountOpcodes,
                  nextTemplateRuntimeValues,
                  state,
                  workInProgress,
                );
              } else {
                const templateUpdateOpcodes = mountOpcodesToUpdateOpcodes.get(nextTemplateMountOpcodes);
                renderUpdateOpcodes(
                  templateUpdateOpcodes,
                  previousTemplateRuntimeValues,
                  nextTemplateRuntimeValues,
                  state,
                  workInProgress,
                );
              }
              break;
            }
            branchIndex += 2;
          }
        }
        if (branchHasChanged === true) {
          const previousTemplateMountOpcodes = values[branchMountOpcodesPointer];
          if (previousTemplateMountOpcodes !== null) {
            const previousBranchUnmountOpcodes = mountOpcodesToUnmountOpcodes.get(previousTemplateMountOpcodes);
            renderUnmountOpcodes(previousBranchUnmountOpcodes, state, workInProgress, true);
          }
          values[branchMountOpcodesPointer] = nextTemplateMountOpcodes;
        }
        if (nextHostNode !== undefined) {
          const previousHostNode = values[hostNodeValuePointer];
          replaceChild(previousHostNode, nextHostNode);
          values[hostNodeValuePointer] = nextHostNode;
        }
        return nextHostNode;
      }
      case COMPONENT: {
        const usesHooks = updateOpcodes[++index];
        const componentMountOpcodes = updateOpcodes[++index];
        const componentUpdateOpcodes = mountOpcodesToUpdateOpcodes.get(componentMountOpcodes);
        let currentComponent = state.currentComponent;
        let componentFiber;
        const previousComponent = currentComponent;
        if (workInProgress === null) {
          componentFiber = state.fiber;
        }
        let component = componentFiber.values[0];
        let nextPropsArray;

        if (currentComponent === null) {
          const rootPropsShape = updateOpcodes[++index];
          nextPropsArray = convertRootPropsToPropsArray(state.rootPropsObject, rootPropsShape);
        } else {
          nextPropsArray = state.propsArray;
        }
        component.props = nextPropsArray;
        state.currentComponent = currentComponent = component;
        // if (usesHooks === 1) {
        //   prepareToUseHooks(componentFiber);
        // }
        // renderUpdateOpcodes(componentUpdateOpcodes, previousRuntimeValues, nextRuntimeValues, state, componentFiber);
        // if (usesHooks === 1) {
        //   finishHooks(currentComponent);
        // }
        state.currentComponent = previousComponent;
        return;
      }
      default:
        ++index;
    }
    ++index;
  }
}

function renderUnmountOpcodes(unmountOpcodes, state, workInProgress, skipHostNodeRemoval) {
  const opcodesLength = unmountOpcodes.length;
  let index = 0;

  // Render opcodes from the opcode jump-table
  while (index < opcodesLength) {
    const opcode = unmountOpcodes[index];

    switch (opcode) {
      case COMPONENT: {
        const usesHooks = unmountOpcodes[++index];
        usesHooks; // TODO
        let currentComponent = state.currentComponent;
        let componentFiber;
        const previousComponent = currentComponent;
        if (workInProgress === null) {
          componentFiber = state.fiber;
        }
        const component = componentFiber.values[0];
        const componentUnmountOpcodes = unmountOpcodes[++index];
        state.currentComponent = currentComponent = component;
        renderUnmountOpcodes(componentUnmountOpcodes, state, componentFiber, skipHostNodeRemoval);
        state.currentComponent = previousComponent;
        return;
      }
      default:
        ++index;
    }
    ++index;
  }
}

function unmountRoot(DOMContainer, rootState) {
  const unmountOpcodes = mountOpcodesToUnmountOpcodes.get(rootState.mountOpcodes);
  renderUnmountOpcodes(unmountOpcodes, rootState, null, true);
  removeChild(DOMContainer, rootState.fiber.hostNode);
  rootState.fiber = null;
}

function State(mountOpcodes) {
  this.currentHostNode = null;
  this.currentHostNodeStack = [];
  this.currentHostNodeStackIndex = 0;
  this.fiber = null;
  this.mountOpcodes = mountOpcodes;
  this.propsArray = null;
  this.rootPropsObject = null;
}

function renderNodeToRootContainer(node, DOMContainer) {
  let rootState = rootStates.get(DOMContainer);

  if (node === null || node === undefined) {
    if (rootState !== undefined) {
      unmountRoot(DOMContainer, rootState);
    }
  } else if (node.$$typeof === reactElementSymbol) {
    const mountOpcodes = node.type;
    let shouldUpdate = false;

    if (rootState === undefined) {
      rootState = new State(mountOpcodes);
      rootStates.set(DOMContainer, rootState);
    } else {
      if (rootState.fiber !== null) {
        if (rootState.mountOpcodes === mountOpcodes) {
          shouldUpdate = true;
        } else {
          unmountRoot(DOMContainer, rootState);
        }
      }
    }
    rootState.mountOpcodes = mountOpcodes;
    rootState.rootPropsObject = node.props;
    if (shouldUpdate === true) {
      const updateOpcodes = mountOpcodesToUpdateOpcodes.get(mountOpcodes);
      renderUpdateOpcodes(updateOpcodes, emptyArray, emptyArray, rootState, null);
    } else {
      const hostNode = renderMountOpcodes(mountOpcodes, emptyArray, rootState, null);
      appendChild(DOMContainer, hostNode);
    }
  } else {
    throw new Error("render() expects a ReactElement as the first argument");
  }
}

export function render(node, DOMContainer) {
  const prevDispatcher = currentDispatcher.current;
  currentDispatcher.current = Dispatcher;
  const returnNode = renderNodeToRootContainer(node, DOMContainer);
  currentDispatcher.current = prevDispatcher;
  return returnNode;
}
