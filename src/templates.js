import * as t from "@babel/types";
import { markNodeAsUsed } from "./utils";

export const ROOT_COMPONENT = 0;
export const COMPONENT = 1;
export const HOST_COMPONENT = 2;
export const TEXT = 3;
export const VALUE = 4;
export const FRAGMENT = 5;
export const CONDITIONAL = 6;
export const TEMPLATE_FUNCTION_CALL = 7;
export const MULTI_CONDITIONAL = 8;
export const TEXT_ARRAY = 9;
export const REFERENCE_COMPONENT = 10;
export const VNODE = 11;
export const REFERENCE_VNODE = 12;
export const MULTI_RETURN_CONDITIONAL = 13;

export const HAS_STATIC_PROPS = 1 << 6;
export const HAS_DYNAMIC_PROPS = 1 << 7;
export const HAS_STATIC_STYLES = 1 << 8;
export const HAS_DYNAMIC_STYLES = 1 << 9;
export const HAS_CHILD = 1 << 10;
export const HAS_CHILDREN = 1 << 11;
export const HAS_STATIC_TEXT_CONTENT = 1 << 12;
export const HAS_DYNAMIC_TEXT_CONTENT = 1 << 13;
export const HAS_DYNAMIC_TEXT_ARRAY_CONTENT = 1 << 14;
export const IS_STATIC = 1 << 15;
export const IS_SVG = 1 << 16;
export const IS_VOID = 1 << 17;
export const HAS_HOOKS = 1 << 18;

function valueToBabelNode(value) {
  if (typeof value === "boolean") {
    return t.booleanLiteral(value);
  } else if (typeof value === "number") {
    return t.numericLiteral(value);
  } else if (typeof value === "string") {
    return t.stringLiteral(value);
  } else if (value === null) {
    return t.nullLiteral();
  } else if (value === undefined) {
    return t.unaryExpression("void", t.numericLiteral(0));
  }
  throw new Error("TODO");
}

export class ComponentTemplateNode {
  constructor(
    name,
    componentPath,
    isRootComponent,
    usesHooks,
    defaultProps,
    functionKind,
    typeAnnotation,
    shapeOfPropsObject,
  ) {
    this.name = name;
    this.componentPath = componentPath;
    this.insertPath = null;
    this.isStatic = false;
    this.computeFunctionRef = null;
    this.templateNode = null;
    this.isRootComponent = isRootComponent;
    this.usesHooks = usesHooks;
    this.defaultProps = defaultProps;
    this.functionKind = functionKind;
    this.typeAnnotation = typeAnnotation;
    this.shapeOfPropsObject = shapeOfPropsObject;
    this.propsArray = null;
    this.propsValueIndex = null;
    this.childComponents = [];
    this.insertionPath = null;
  }

  toAST() {
    const ASTNode = [];
    let flag = this.isRootComponent ? ROOT_COMPONENT : COMPONENT;
    if (this.isStatic) {
      flag |= IS_STATIC;
    }
    if (this.usesHooks) {
      flag |= HAS_HOOKS;
    }
    // TODO: Maybe change to hex if less bytes?
    ASTNode.push(t.numericLiteral(flag));
    if (!this.isStatic) {
      if (this.isRootComponent) {
        if (this.shapeOfPropsObject === null) {
          ASTNode.push(t.numericLiteral(0));
        } else {
          ASTNode.push(t.arrayExpression(this.shapeOfPropsObject.map(a => t.stringLiteral(a.value))));
        }
      }
      ASTNode.push(t.identifier(this.computeFunctionRef));
    }
    if (this.templateNode !== null) {
      ASTNode.push(this.templateNode.toAST());
    }
    return t.arrayExpression(ASTNode);
  }
}

export class ReferenceComponentTemplateNode {
  constructor(componentRefName, componentTemplateNode, propsArrayASTNode) {
    this.componentTemplateNode = componentTemplateNode;
    this.componentRefName = componentRefName;
    this.propsArrayASTNode = propsArrayASTNode;
  }

  toAST() {
    const componentRefIdentifier = t.identifier(this.componentRefName);
    markNodeAsUsed(componentRefIdentifier);
    let flags = REFERENCE_COMPONENT;

    if (t.isArrayExpression(this.propsArrayASTNode)) {
      flags |= HAS_STATIC_PROPS;
    }

    return t.arrayExpression([t.numericLiteral(flags), componentRefIdentifier, this.propsArrayASTNode]);
  }
}

export class StaticReactNode {
  constructor() {
    this.isStatic = true;
    // TODO
  }

  toAST() {
    debugger;
  }
}

export class ReferenceVNode {
  constructor(valueIndex) {
    debugger;
    this.valueIndex = valueIndex;
  }

  toAST() {
    return t.arrayExpression([t.numericLiteral(REFERENCE_VNODE), t.numericLiteral(this.valueIndex)]);
  }
}

export class HostComponentTemplateNode {
  constructor(tagName, isVoidElement) {
    this.tagName = tagName;
    this.isVoidElement = isVoidElement;
    this.staticProps = [];
    this.dynamicProps = [];
    this.staticStyles = [];
    this.dynamicStyles = [];
    this.children = [];
    this.isStatic = false;
  }

  toAST() {
    const ASTNode = [];
    const hasStaticProps = this.staticProps.length !== 0;
    const hasDynamicProps = this.dynamicProps.length !== 0;
    const hasStaticStyles = this.staticStyles.length !== 0;
    const hasDynamicStyles = this.dynamicStyles.length !== 0;
    const childrenLength = this.children.length;
    let flag = HOST_COMPONENT;
    let staticPropsASTNode = null;
    let dynamicPropsASTNode = null;
    let staticStylesASTNode = null;
    let dynamicStylesASTNode = null;
    let childrenASTNode = null;

    if (this.isStatic) {
      flag |= IS_STATIC;
    }
    if (this.isVoidElement) {
      flag |= IS_VOID;
    }
    if (hasStaticProps) {
      flag |= HAS_STATIC_PROPS;
      const staticPropASTNodes = [];
      for (let [propName, propInformation, propValue] of this.staticProps) {
        staticPropASTNodes.push(
          t.stringLiteral(propName),
          t.numericLiteral(propInformation),
          valueToBabelNode(propValue),
        );
      }
      staticPropsASTNode = t.arrayExpression(staticPropASTNodes);
    }
    if (hasStaticStyles) {
      flag |= HAS_STATIC_STYLES;
      const staticStylesASTNodes = [];
      for (let [styleName, propValue] of this.staticStyles) {
        staticStylesASTNodes.push(t.stringLiteral(styleName), valueToBabelNode(propValue));
      }
      staticStylesASTNode = t.arrayExpression(staticStylesASTNodes);
    }
    if (hasDynamicProps) {
      flag |= HAS_DYNAMIC_PROPS;
      const dynamicPropASTNodes = [];
      for (let [propName, propInformation, valueIndex] of this.dynamicProps) {
        dynamicPropASTNodes.push(
          t.stringLiteral(propName),
          t.numericLiteral(propInformation),
          t.numericLiteral(valueIndex),
        );
      }
      dynamicPropsASTNode = t.arrayExpression(dynamicPropASTNodes);
    }
    if (hasDynamicStyles) {
      flag |= HAS_DYNAMIC_STYLES;
      const dynamicStylesASTNodes = [];
      for (let [styleName, valueIndex] of this.dynamicStyles) {
        dynamicStylesASTNodes.push(t.stringLiteral(styleName), t.numericLiteral(valueIndex));
      }
      dynamicStylesASTNode = t.arrayExpression(dynamicStylesASTNodes);
    }
    if (childrenLength === 1) {
      const child = this.children[0];

      if (child instanceof StaticTextTemplateNode) {
        flag |= HAS_STATIC_TEXT_CONTENT;
        childrenASTNode = t.stringLiteral(child.text);
      } else if (child instanceof DynamicTextTemplateNode) {
        flag |= HAS_DYNAMIC_TEXT_CONTENT;
        childrenASTNode = t.numericLiteral(child.valueIndex);
      } else if (child instanceof FragmentTemplateNode) {
        debugger;
      } else if (child instanceof DynamicTextArrayTemplateNode) {
        flag |= HAS_DYNAMIC_TEXT_ARRAY_CONTENT;
        childrenASTNode = t.numericLiteral(child.valueIndex);
      } else if (child instanceof StaticValueTemplateNode) {
        // Should not happen
        debugger;
      } else {
        flag |= HAS_CHILD;
        childrenASTNode = child.toAST();
      }
    } else if (childrenLength > 1) {
      flag |= HAS_CHILDREN;
      const childrenASTNodes = [];
      for (let child of this.children) {
        if (child instanceof FragmentTemplateNode) {
          debugger;
        } else if (child instanceof StaticValueTemplateNode) {
          // Should not happen
          debugger;
        } else {
          childrenASTNodes.push(child.toAST());
        }
      }
      childrenASTNode = t.arrayExpression(childrenASTNodes);
    }
    // TODO: Maybe change to hex if less bytes?
    ASTNode.push(t.numericLiteral(flag));
    ASTNode.push(t.stringLiteral(this.tagName));

    if (staticPropsASTNode !== null) {
      ASTNode.push(staticPropsASTNode);
    }
    if (staticStylesASTNode !== null) {
      ASTNode.push(staticStylesASTNode);
    }
    if (dynamicPropsASTNode !== null) {
      ASTNode.push(dynamicPropsASTNode);
    }
    if (dynamicStylesASTNode !== null) {
      ASTNode.push(dynamicStylesASTNode);
    }
    if (childrenASTNode !== null) {
      ASTNode.push(childrenASTNode);
    }
    return t.arrayExpression(ASTNode);
  }
}

export class StaticTextTemplateNode {
  constructor(text) {
    this.isStatic = true;
    this.text = text;
  }

  toAST() {
    return t.arrayExpression([t.numericLiteral(TEXT | IS_STATIC), t.stringLiteral(this.text + "")]);
  }
}

export class DynamicTextArrayTemplateNode {
  constructor(valueIndex) {
    this.valueIndex = valueIndex;
  }

  toAST() {
    return t.arrayExpression([t.numericLiteral(TEXT_ARRAY), t.numericLiteral(this.valueIndex)]);
  }
}

export class DynamicTextTemplateNode {
  constructor(valueIndex) {
    this.valueIndex = valueIndex;
  }

  toAST() {
    return t.arrayExpression([t.numericLiteral(TEXT), t.numericLiteral(this.valueIndex)]);
  }
}

export class StaticValueTemplateNode {
  constructor(value) {
    this.isStatic = true;
    this.value = value;
  }

  toAST() {
    return t.arrayExpression([t.numericLiteral(VALUE | IS_STATIC), valueToBabelNode(this.value)]);
  }
}

export class DynamicValueTemplateNode {
  constructor(valueIndex) {
    this.valueIndex = valueIndex;
  }

  toAST() {
    debugger;
  }
}

export class TemplateFunctionCallTemplateNode {
  constructor(templateNode, computeFunctionValueIndex) {
    this.templateNode = templateNode;
    this.computeFunctionValueIndex = computeFunctionValueIndex;
  }

  toAST() {
    return t.arrayExpression([
      t.numericLiteral(TEMPLATE_FUNCTION_CALL),
      this.templateNode.toAST(),
      t.numericLiteral(this.computeFunctionValueIndex),
    ]);
  }
}

export class MultiConditionalTemplateNode {
  constructor() {
    this.conditions = [];
  }

  toAST() {
    const conditionsASTNodes = [];

    for (let { conditionTemplateNode, isDefault, valueIndex } of this.conditions) {
      if (isDefault) {
        conditionsASTNodes.push(t.nullLiteral());
      } else {
        conditionsASTNodes.push(t.numericLiteral(valueIndex));
      }
      conditionsASTNodes.push(conditionTemplateNode.toAST());
    }
    return t.arrayExpression([t.numericLiteral(MULTI_CONDITIONAL), t.arrayExpression(conditionsASTNodes)]);
  }
}

export class MultiReturnConditionalTemplateNode {
  constructor() {
    this.conditions = [];
    this.isStatic = false;
  }

  toAST() {
    const multiReturnASTNodes = [t.numericLiteral(MULTI_RETURN_CONDITIONAL)];
    for (let [branchIndex, templateNode] of this.conditions) {
      multiReturnASTNodes.push(t.numericLiteral(branchIndex), templateNode.toAST());
    }
    return t.arrayExpression(multiReturnASTNodes);
  }
}

export class FragmentTemplateNode {
  constructor(children) {
    this.children = children;
  }

  toAST() {
    return t.arrayExpression([
      t.numericLiteral(FRAGMENT),
      t.arrayExpression(this.children.map(child => child.toAST())),
    ]);
  }
}

export class ConditionalTemplateNode {
  constructor(valueIndex, alternateTemplateNode, consequentTemplateNode) {
    this.valueIndex = valueIndex;
    this.alternateTemplateNode = alternateTemplateNode;
    this.consequentTemplateNode = consequentTemplateNode;
  }

  toAST() {
    return t.arrayExpression([
      t.numericLiteral(CONDITIONAL),
      t.numericLiteral(this.valueIndex),
      this.alternateTemplateNode.toAST(),
      this.consequentTemplateNode.toAST(),
    ]);
  }
}
