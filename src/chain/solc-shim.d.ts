// solc-js ships no type declarations. This is the entire slice of its
// surface we use: the synchronous high-level `compile` function over the
// Solidity Standard JSON input/output format.
// https://docs.soliditylang.org/en/latest/using-the-compiler.html#compiler-input-and-output-json-description
declare module "solc" {
  interface SolcCompiler {
    compile(input: string): string;
  }
  const solc: SolcCompiler;
  export default solc;
}
