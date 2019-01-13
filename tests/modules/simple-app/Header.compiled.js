function Header() {
  return (// Header OPCODES
    [0, 0, 0 // COMPONENT
    , [0, 0, 20 // UNCONDITIONAL_TEMPLATE
    , [0, 0, 8 // OPEN_ELEMENT_DIV
    , 0 // VALUE_POINTER_INDEX
    , 41 // ELEMENT_STATIC_CHILDREN_VALUE
    , "Header", 10 // CLOSE_ELEMENT
    ], 0 // VALUE_POINTER_INDEX
    , null // COMPUTE_FUNCTION
    ]]
  );
}

module.exports = Header;