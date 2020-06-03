import commonjs from "rollup-plugin-commonjs";
import nodeResolve from "rollup-plugin-node-resolve";
import replace from "rollup-plugin-replace";
import babel from "rollup-plugin-babel";
import closure from 'rollup-plugin-google-closure-compiler';

export default {
  input: "src/solid.js",
  output: {
    file: "build/solid-bundle.js",
    format: "umd",
    name: "App",
  },
  plugins: [
    replace({
      "process.env.NODE_ENV": JSON.stringify("production"),
    }),
    babel({
      presets: [
        [
          "@babel/preset-env",
          {
            loose: true,
            modules: false,
            targets: {
              ie: "11",
            },
          },
        ],
        'solid',
      ],
    }),
    nodeResolve({
      jsnext: true,
      main: true,
    }),
    commonjs(),
    closure(),
  ],
};
