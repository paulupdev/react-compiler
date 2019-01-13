// props:{x: "Hello world!"}
var {
  ["Header"]: Header,
  ["formatString"]: formatString
} = require("./Header.compiled.js");

var Footer = require("./Footer.compiled.js");

import type { IndexProps } from "./type";

function App_ComputeFunction(x) {
  var __cached__0;

  __cached__0 = formatString(x);
  return [[x], __cached__0, [x]];
}

var App = // App OPCODES
[0, 0, 0 // COMPONENT
, ["x"] // ROOT_PROPS_SHAPE
, [0, 0, 20 // UNCONDITIONAL_TEMPLATE
, [0, 0, 8 // OPEN_ELEMENT_DIV
, 0 // VALUE_POINTER_INDEX
, 29 // REF_COMPONENT
, Header, 0 // COMPONENT_PROPS_ARRAY
, 42 // ELEMENT_DYNAMIC_CHILD_VALUE
, 1, 29 // REF_COMPONENT
, Footer, 2 // COMPONENT_PROPS_ARRAY
, 10 // CLOSE_ELEMENT
], 0 // VALUE_POINTER_INDEX
, App_ComputeFunction // COMPUTE_FUNCTION
]];
module["exports"] = App;