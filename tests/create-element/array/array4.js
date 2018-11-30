// props:{items: [1,2,3,4,5]}
var React = require("react");

function Component({ items }: { items: Array<number> }) {
  const children = items
    .filter((item: number) => item % 2)
    .map(
      (item, i: number): React.Node =>
        React.createElement(
          "li",
          {
            key: i,
          },
          "Static item!",
        ),
    );
  return React.createElement("ul", null, children);
}

Component.compileRootComponent = true;

module.exports = Component;
