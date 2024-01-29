import { Blocktype, Opcodes, Valtype, PageSize, ValtypeSize } from "./wasmSpec.js";
import { ieee754_binary64, signedLEB128, unsignedLEB128, encodeVector } from "./encoding.js";
import { operatorOpcode } from "./expression.js";
import { BuiltinFuncs, BuiltinVars, importedFuncs, NULL, UNDEFINED } from "./builtins.js";
import { PrototypeFuncs } from "./prototype.js";
import { number, i32x4, enforceOneByte, enforceTwoBytes, enforceFourBytes, enforceEightBytes } from "./embedding.js";
import { log } from "./log.js";
import parse from "./parse.js";
import * as Rhemyn from "../rhemyn/compile.js";

let globals = {};
let globalInd = 0;
let tags = [];
let funcs = [];
let exceptions = [];
let funcIndex = {};
let currentFuncIndex = importedFuncs.length;
let builtinFuncs = {}, builtinVars = {}, prototypeFuncs = {};

const debug = str => {
  const code = [];

  const logChar = n => {
    code.push(...number(n));

    code.push(Opcodes.call);
    code.push(...unsignedLEB128(0));
  };

  for (let i = 0; i < str.length; i++) {
    logChar(str.charCodeAt(i));
  }

  logChar('\n'.charCodeAt(0));

  return code;
};

const todo = msg => {
  class TodoError extends Error {
    constructor(message) {
      super(message);
      this.name = 'TodoError';
    }
  }

  throw new TodoError(`todo: ${msg}`);

  const code = [];

  code.push(...debug(`todo! ` + msg));
  code.push(Opcodes.unreachable);

  return code;
};

const isFuncType = type => type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression';
const generate = (scope, decl, global = false, name = undefined) => {
  switch (decl.type) {
    case 'BinaryExpression':
      return generateBinaryExp(scope, decl, global, name);

    case 'LogicalExpression':
      return generateLogicExp(scope, decl);

    case 'Identifier':
      return generateIdent(scope, decl);

    case 'ArrowFunctionExpression':
    case 'FunctionDeclaration':
      generateFunc(scope, decl);
      return [];

    case 'BlockStatement':
      return generateCode(scope, decl);

    case 'ReturnStatement':
      return generateReturn(scope, decl);

    case 'ExpressionStatement':
      return generateExp(scope, decl);

    case 'CallExpression':
      return generateCall(scope, decl, global, name);

    case 'NewExpression':
      return generateNew(scope, decl, global, name);

    case 'Literal':
      return generateLiteral(scope, decl, global, name);

    case 'VariableDeclaration':
      return generateVar(scope, decl);

    case 'AssignmentExpression':
      return generateAssign(scope, decl);

    case 'UnaryExpression':
      return generateUnary(scope, decl);

    case 'UpdateExpression':
      return generateUpdate(scope, decl);

    case 'IfStatement':
      return generateIf(scope, decl);

    case 'ForStatement':
      return generateFor(scope, decl);

    case 'WhileStatement':
      return generateWhile(scope, decl);

    case 'ForOfStatement':
      return generateForOf(scope, decl);

    case 'BreakStatement':
      return generateBreak(scope, decl);

    case 'ContinueStatement':
      return generateContinue(scope, decl);

    case 'EmptyStatement':
      return generateEmpty(scope, decl);

    case 'ConditionalExpression':
      return generateConditional(scope, decl);

    case 'ThrowStatement':
      return generateThrow(scope, decl);

    case 'TryStatement':
      return generateTry(scope, decl);

    case 'DebuggerStatement':
      // todo: add fancy terminal debugger?
      return [];

    case 'ArrayExpression':
      return generateArray(scope, decl, global, name);

    case 'MemberExpression':
      return generateMember(scope, decl, global, name);

    case 'ExportNamedDeclaration':
      // hack to flag new func for export
      const funcsBefore = funcs.length;
      generate(scope, decl.declaration);

      if (funcsBefore === funcs.length) throw new Error('no new func added in export');

      const newFunc = funcs[funcs.length - 1];
      newFunc.export = true;

      return [];

    case 'TaggedTemplateExpression': {
      const funcs = {
        asm: str => {
          let out = [];

          for (const line of str.split('\n')) {
            const asm = line.trim().split(';;')[0].split(' ');
            if (asm[0] === '') continue; // blank

            if (asm[0] === 'local') {
              const [ name, idx, type ] = asm.slice(1);
              scope.locals[name] = { idx: parseInt(idx), type: Valtype[type] };
              continue;
            }

            if (asm[0] === 'returns') {
              scope.returns = asm.slice(1).map(x => Valtype[x]);
              continue;
            }

            if (asm[0] === 'memory') {
              allocPage('asm instrinsic');
              // todo: add to store/load offset insts
              continue;
            }

            let inst = Opcodes[asm[0].replace('.', '_')];
            if (!inst) throw new Error(`inline asm: inst ${asm[0]} not found`);

            if (!Array.isArray(inst)) inst = [ inst ];
            const immediates = asm.slice(1).map(x => parseInt(x));

            out.push([ ...inst, ...immediates ]);
          }

          return out;
        },

        __internal_print_type: str => {
          const type = getType(scope, str) - TYPES.number;

          return [
            ...number(type),
            [ Opcodes.call, importedFuncs.print ],

            // newline
            ...number(10),
            [ Opcodes.call, importedFuncs.printChar ]
          ];
        }
      }

      const name = decl.tag.name;
      // hack for inline asm
      if (!funcs[name]) return todo('tagged template expressions not implemented');

      const str = decl.quasi.quasis[0].value.raw;
      return funcs[name](str);
    }

    default:
      if (decl.type.startsWith('TS')) {
        // ignore typescript nodes
        return [];
      }

      return todo(`no generation for ${decl.type}!`);
  }
};

const mapName = x => {
  if (!x) return x;

  if (x.startsWith('__globalThis_')) {
    const key = x.slice('__globalThis_'.length);
    // hack: this will not work properly
    return key.includes('_') ? ('__' + key) : key;
  }

  return x;
};

const lookupName = (scope, _name) => {
  const name = mapName(_name);

  let local = scope.locals[name];
  if (local) return [ local, false ];

  let global = globals[name];
  if (global) return [ global, true ];

  return [ undefined, undefined ];
};

const internalThrow = (scope, constructor, message, expectsValue = false) => [
  ...generateThrow(scope, {
    argument: {
      type: 'NewExpression',
      callee: {
        name: constructor
      },
      arguments: [
        {
          value: message
        }
      ]
    }
  }),
  ...(expectsValue ? number(UNDEFINED) : [])
];

const generateIdent = (scope, decl) => {
  const lookup = rawName => {
    const name = mapName(rawName);
    let local = scope.locals[rawName];

    if (builtinVars[name]) {
      if (builtinVars[name].floatOnly && valtype[0] === 'i') throw new Error(`Cannot use ${unhackName(name)} with integer valtype`);
      return builtinVars[name];
    }

    if (builtinFuncs[name] || internalConstrs[name]) {
      // todo: return an actual something
      return number(1);
    }

    if (local === undefined) {
      // no local var with name
      if (importedFuncs.hasOwnProperty(name)) return number(importedFuncs[name]);
      if (funcIndex[name] !== undefined) return number(funcIndex[name]);

      if (globals[name] !== undefined) return [ [ Opcodes.global_get, globals[name].idx ] ];
    }

    if (local === undefined && rawName.startsWith('__')) {
      // return undefined if unknown key in already known var
      let parent = rawName.slice(2).split('_').slice(0, -1).join('_');
      if (parent.includes('_')) parent = '__' + parent;

      const parentLookup = lookup(parent);
      if (!parentLookup[1]) return number(UNDEFINED);
    }

    if (local === undefined) return internalThrow(scope, 'ReferenceError', `${unhackName(name)} is not defined`, true);

    return [ [ Opcodes.local_get, local.idx ] ];
  };

  return lookup(decl.name);
};

const generateReturn = (scope, decl) => {
  if (decl.argument === null) {
    // just bare "return"
    return [
      ...number(UNDEFINED), // "undefined" if func returns
      ...number(TYPES.undefined, Valtype.i32), // type undefined
      [ Opcodes.return ]
    ];
  }

  return [
    ...generate(scope, decl.argument),
    ...getNodeType(scope, decl.argument),
    [ Opcodes.return ]
  ];
};

const localTmp = (scope, name, type = valtypeBinary) => {
  if (scope.locals[name]) return scope.locals[name].idx;

  let idx = scope.localInd++;
  scope.locals[name] = { idx, type };

  return idx;
};

const isIntOp = op => op && (op[0] >= 0xb7 && op[0] <= 0xba);

const performLogicOp = (scope, op, left, right, leftType, rightType) => {
  const checks = {
    '||': falsy,
    '&&': truthy,
    '??': nullish
  };

  if (!checks[op]) return todo(`logic operator ${op} not implemented yet`);

  // generic structure for {a} OP {b}
  // -->
  // _ = {a}; if (OP_CHECK) {b} else _

  // if we can, use int tmp and convert at the end to help prevent unneeded conversions
  // (like if we are in an if condition - very common)
  const leftIsInt = isIntOp(left[left.length - 1]);
  const rightIsInt = isIntOp(right[right.length - 1]);

  const canInt = leftIsInt && rightIsInt;

  if (canInt) {
    // remove int -> float conversions from left and right
    left.pop();
    right.pop();

    return [
      ...left,
      [ Opcodes.local_tee, localTmp(scope, 'logictmpi', Valtype.i32) ],
      ...checks[op](scope, [], leftType, true, true),
      [ Opcodes.if, Valtype.i32 ],
      ...right,
      // note type
      ...rightType,
      setLastType(scope),
      [ Opcodes.else ],
      [ Opcodes.local_get, localTmp(scope, 'logictmpi', Valtype.i32) ],
      // note type
      ...leftType,
      setLastType(scope),
      [ Opcodes.end ],
      Opcodes.i32_from
    ];
  }

  return [
    ...left,
    [ Opcodes.local_tee, localTmp(scope, 'logictmp') ],
    ...checks[op](scope, [], leftType, false, true),
    [ Opcodes.if, valtypeBinary ],
    ...right,
    // note type
    ...rightType,
    setLastType(scope),
    [ Opcodes.else ],
    [ Opcodes.local_get, localTmp(scope, 'logictmp') ],
    // note type
    ...leftType,
    setLastType(scope),
    [ Opcodes.end ]
  ];
};

const concatStrings = (scope, left, right, global, name, assign) => {
  // todo: this should be rewritten into a built-in/func: String.prototype.concat
  // todo: convert left and right to strings if not
  // todo: optimize by looking up names in arrays and using that if exists?
  // todo: optimize this if using literals/known lengths?

  const rightPointer = localTmp(scope, 'concat_right_pointer', Valtype.i32);
  const rightLength = localTmp(scope, 'concat_right_length', Valtype.i32);
  const leftLength = localTmp(scope, 'concat_left_length', Valtype.i32);

  const aotWFA = process.argv.includes('-aot-well-formed-string-approximation');
  if (aotWFA) addVarMeta(name, { wellFormed: undefined });

  if (assign) {
    const pointer = arrays.get(name ?? '$undeclared');

    return [
      // setup right
      ...right,
      Opcodes.i32_to_u,
      [ Opcodes.local_set, rightPointer ],

      // calculate length
      ...number(0, Valtype.i32), // base 0 for store later

      ...number(pointer, Valtype.i32),
      [ Opcodes.i32_load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128(0) ],
      [ Opcodes.local_tee, leftLength ],

      [ Opcodes.local_get, rightPointer ],
      [ Opcodes.i32_load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128(0) ],
      [ Opcodes.local_tee, rightLength ],

      [ Opcodes.i32_add ],

      // store length
      [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ],

      // copy right
      // dst = out pointer + length size + current length * i16 size
      ...number(pointer + ValtypeSize.i32, Valtype.i32),

      [ Opcodes.local_get, leftLength ],
      ...number(ValtypeSize.i16, Valtype.i32),
      [ Opcodes.i32_mul ],
      [ Opcodes.i32_add ],

      // src = right pointer + length size
      [ Opcodes.local_get, rightPointer ],
      ...number(ValtypeSize.i32, Valtype.i32),
      [ Opcodes.i32_add ],

      // size = right length * i16 size
      [ Opcodes.local_get, rightLength ],
      ...number(ValtypeSize.i16, Valtype.i32),
      [ Opcodes.i32_mul ],

      [ ...Opcodes.memory_copy, 0x00, 0x00 ],

      // return new string (page)
      ...number(pointer)
    ];
  }

  const leftPointer = localTmp(scope, 'concat_left_pointer', Valtype.i32);

  // alloc/assign array
  const [ , pointer ] = makeArray(scope, {
    rawElements: new Array(0)
  }, global, name, true, 'i16');

  return [
    // setup left
    ...left,
    Opcodes.i32_to_u,
    [ Opcodes.local_set, leftPointer ],

    // setup right
    ...right,
    Opcodes.i32_to_u,
    [ Opcodes.local_set, rightPointer ],

    // calculate length
    ...number(0, Valtype.i32), // base 0 for store later

    [ Opcodes.local_get, leftPointer ],
    [ Opcodes.i32_load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128(0) ],
    [ Opcodes.local_tee, leftLength ],

    [ Opcodes.local_get, rightPointer ],
    [ Opcodes.i32_load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128(0) ],
    [ Opcodes.local_tee, rightLength ],

    [ Opcodes.i32_add ],

    // store length
    [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ],

    // copy left
    // dst = out pointer + length size
    ...number(pointer + ValtypeSize.i32, Valtype.i32),

    // src = left pointer + length size
    [ Opcodes.local_get, leftPointer ],
    ...number(ValtypeSize.i32, Valtype.i32),
    [ Opcodes.i32_add ],

    // size = PageSize - length size. we do not need to calculate length as init value
    ...number(pageSize - ValtypeSize.i32, Valtype.i32),
    [ ...Opcodes.memory_copy, 0x00, 0x00 ],

    // copy right
    // dst = out pointer + length size + left length * i16 size
    ...number(pointer + ValtypeSize.i32, Valtype.i32),

    [ Opcodes.local_get, leftLength ],
    ...number(ValtypeSize.i16, Valtype.i32),
    [ Opcodes.i32_mul ],
    [ Opcodes.i32_add ],

    // src = right pointer + length size
    [ Opcodes.local_get, rightPointer ],
    ...number(ValtypeSize.i32, Valtype.i32),
    [ Opcodes.i32_add ],

    // size = right length * i16 size
    [ Opcodes.local_get, rightLength ],
    ...number(ValtypeSize.i16, Valtype.i32),
    [ Opcodes.i32_mul ],

    [ ...Opcodes.memory_copy, 0x00, 0x00 ],

    // return new string (page)
    ...number(pointer)
  ];
};

const compareStrings = (scope, left, right) => {
  // todo: this should be rewritten into a func
  // todo: convert left and right to strings if not
  // todo: optimize by looking up names in arrays and using that if exists?
  // todo: optimize this if using literals/known lengths?

  const leftPointer = localTmp(scope, 'compare_left_pointer', Valtype.i32);
  const leftLength = localTmp(scope, 'compare_left_length', Valtype.i32);
  const rightPointer = localTmp(scope, 'compare_right_pointer', Valtype.i32);
  const rightLength = localTmp(scope, 'compare_right_length', Valtype.i32);

  const index = localTmp(scope, 'compare_index', Valtype.i32);
  const indexEnd = localTmp(scope, 'compare_index_end', Valtype.i32);

  return [
    // setup left
    ...left,
    Opcodes.i32_to_u,
    [ Opcodes.local_tee, leftPointer ],

    // setup right
    ...right,
    Opcodes.i32_to_u,
    [ Opcodes.local_tee, rightPointer ],

    // fast path: check leftPointer == rightPointer
    // use if (block) for everything after to "return" a value early
    [ Opcodes.i32_ne ],
    [ Opcodes.if, Valtype.i32 ],

    // get lengths
    [ Opcodes.local_get, leftPointer ],
    [ Opcodes.i32_load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128(0) ],
    [ Opcodes.local_tee, leftLength ],

    [ Opcodes.local_get, rightPointer ],
    [ Opcodes.i32_load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128(0) ],
    [ Opcodes.local_tee, rightLength ],

    // fast path: check leftLength != rightLength
    [ Opcodes.i32_ne ],
    [ Opcodes.if, Blocktype.void ],
    ...number(0, Valtype.i32),
    [ Opcodes.br, 1 ],
    [ Opcodes.end ],

    // no fast path for length = 0 as it would probably be slower for most of the time?

    // tmp could have already been used
    ...number(0, Valtype.i32),
    [ Opcodes.local_set, index ],

    // setup index end as length * sizeof i16 (2)
    // we do this instead of having to do mul/div each iter for perf™
    [ Opcodes.local_get, leftLength ],
    ...number(ValtypeSize.i16, Valtype.i32),
    [ Opcodes.i32_mul ],
    [ Opcodes.local_set, indexEnd ],

    // iterate over each char and check if eq
    [ Opcodes.loop, Blocktype.void ],

    // fetch left
    [ Opcodes.local_get, index ],
    [ Opcodes.local_get, leftPointer ],
    [ Opcodes.i32_add ],
    [ Opcodes.i32_load16_u, Math.log2(ValtypeSize.i16) - 1, ...unsignedLEB128(ValtypeSize.i32) ],

    // fetch right
    [ Opcodes.local_get, index ],
    [ Opcodes.local_get, rightPointer ],
    [ Opcodes.i32_add ],
    [ Opcodes.i32_load16_u, Math.log2(ValtypeSize.i16) - 1, ...unsignedLEB128(ValtypeSize.i32) ],

    // not equal, "return" false
    [ Opcodes.i32_ne ],
    [ Opcodes.if, Blocktype.void ],
    ...number(0, Valtype.i32),
    [ Opcodes.br, 2 ],
    [ Opcodes.end ],

    // index += sizeof i16 (2)
    [ Opcodes.local_get, index ],
    ...number(ValtypeSize.i16, Valtype.i32),
    [ Opcodes.i32_add ],
    [ Opcodes.local_tee, index ],

    // if index != index end (length * sizeof 16), loop
    [ Opcodes.local_get, indexEnd ],
    [ Opcodes.i32_ne ],
    [ Opcodes.br_if, 0 ],
    [ Opcodes.end ],

    // no failed checks, so true!
    ...number(1, Valtype.i32),

    // pointers match, so true
    [ Opcodes.else ],
    ...number(1, Valtype.i32),
    [ Opcodes.end ],

    // convert i32 result to valtype
    // do not do as automatically added by binary exp gen for equality ops
    // Opcodes.i32_from_u
  ];
};

const truthy = (scope, wasm, type, intIn = false, intOut = false) => {
  if (isIntOp(wasm[wasm.length - 1])) return [
    ...wasm,
    ...(!intIn && intOut ? [ Opcodes.i32_to_u ] : [])
  ];

  const tmp = localTmp(scope, `$logicinner_tmp${intIn ? '_int' : ''}`, intIn ? Valtype.i32 : valtypeBinary);

  const def = [
    // if value != 0
    [ Opcodes.local_get, tmp ],

    // ...(intIn ? [ [ Opcodes.i32_eqz ] ] : [ ...Opcodes.eqz ]),
    ...(!intOut || (intIn && intOut) ? [] : [ Opcodes.i32_to_u ]),

    /* Opcodes.eqz,
    [ Opcodes.i32_eqz ],
    Opcodes.i32_from */
  ];

  return [
    ...wasm,
    [ Opcodes.local_set, tmp ],

    ...typeSwitch(scope, type, {
      // [TYPES.number]: def,
      [TYPES._array]: [
        // arrays are always truthy
        ...number(1, intOut ? Valtype.i32 : valtypeBinary)
      ],
      [TYPES.string]: [
        [ Opcodes.local_get, tmp ],
        ...(intIn ? [] : [ Opcodes.i32_to_u ]),

        // get length
        [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, 0 ],

        // if length != 0
        /* [ Opcodes.i32_eqz ],
        [ Opcodes.i32_eqz ], */
        ...(intOut ? [] : [ Opcodes.i32_from_u ])
      ],
      default: def
    }, intOut ? Valtype.i32 : valtypeBinary)
  ];
};

const falsy = (scope, wasm, type, intIn = false, intOut = false) => {
  const tmp = localTmp(scope, `$logicinner_tmp${intIn ? '_int' : ''}`, intIn ? Valtype.i32 : valtypeBinary);
  return [
    ...wasm,
    [ Opcodes.local_set, tmp ],

    ...typeSwitch(scope, type, {
      [TYPES._array]: [
        // arrays are always truthy
        ...number(0, intOut ? Valtype.i32 : valtypeBinary)
      ],
      [TYPES.string]: [
        [ Opcodes.local_get, tmp ],
        ...(intIn ? [] : [ Opcodes.i32_to_u ]),

        // get length
        [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, 0 ],

        // if length == 0
        [ Opcodes.i32_eqz ],
        ...(intOut ? [] : [ Opcodes.i32_from_u ])
      ],
      default: [
        // if value == 0
        [ Opcodes.local_get, tmp ],

        ...(intIn ? [ [ Opcodes.i32_eqz ] ] : [ ...Opcodes.eqz ]),
        ...(intOut ? [] : [ Opcodes.i32_from_u ])
      ]
    }, intOut ? Valtype.i32 : valtypeBinary)
  ];
};

const nullish = (scope, wasm, type, intIn = false, intOut = false) => {
  const tmp = localTmp(scope, `$logicinner_tmp${intIn ? '_int' : ''}`, intIn ? Valtype.i32 : valtypeBinary);
  return [
    ...wasm,
    [ Opcodes.local_set, tmp ],

    ...typeSwitch(scope, type, {
      [TYPES.undefined]: [
        // undefined
        ...number(1, intOut ? Valtype.i32 : valtypeBinary)
      ],
      [TYPES.object]: [
        // object, null if == 0
        [ Opcodes.local_get, tmp ],

        ...(intIn ? [ [ Opcodes.i32_eqz ] ] : [ ...Opcodes.eqz ]),
        ...(intOut ? [] : [ Opcodes.i32_from_u ])
      ],
      default: [
        // not
        ...number(0, intOut ? Valtype.i32 : valtypeBinary)
      ]
    }, intOut ? Valtype.i32 : valtypeBinary)
  ];
};

const stringOnly = wasm => {
  if (!Array.isArray(wasm[0])) return [ ...wasm, 'string_only' ];
  if (wasm.length === 1) return [ [ ...wasm[0], 'string_only' ] ];

  return [
    [ ...wasm[0], 'string_only|start' ],
    ...wasm.slice(1, -1),
    [ ...wasm[wasm.length - 1], 'string_only|end' ]
  ];
}

const performOp = (scope, op, left, right, leftType, rightType, _global = false, _name = '$undeclared', assign = false) => {
  if (op === '||' || op === '&&' || op === '??') {
    return performLogicOp(scope, op, left, right, leftType, rightType);
  }

  const eqOp = ['==', '===', '!=', '!==', '>', '>=', '<', '<='].includes(op);
  const strictOp = op === '===' || op === '!==';

  const startOut = [], endOut = [];
  const finalise = out => startOut.concat(out, endOut);

  // if strict (in)equal check types match
  if (strictOp) {
    // startOut.push(
    //   ...leftType,
    //   ...rightType,
    //   [ Opcodes.i32_eq ]
    // );

    // endOut.push(
    //   [ Opcodes.i32_and ]
    // );

    // startOut.push(
    //   [ Opcodes.block, Valtype.i32 ],
    //   ...leftType,
    //   ...rightType,
    //   [ Opcodes.i32_ne ],
    //   [ Opcodes.if, Blocktype.void ],
    //   ...number(op === '===' ? 0 : 1, Valtype.i32),
    //   [ Opcodes.br, 1 ],
    //   [ Opcodes.end ]
    // );

    // endOut.push(
    //   [ Opcodes.end ]
    // );

    endOut.push(
      ...leftType,
      ...rightType,
      ...(op === '===' ? [
        [ Opcodes.i32_eq ],
        [ Opcodes.i32_and ]
      ] : [
        [ Opcodes.i32_ne ],
        [ Opcodes.i32_or ]
      ])
    );
  }

  // todo: if equality op and an operand is undefined, return false
  // todo: niche null hell with 0

  // if (leftType === TYPES.string || rightType === TYPES.string) {
  //   if (op === '+') {
  //     // string concat (a + b)
  //     return finalise(concatStrings(scope, left, right, _global, _name, assign));
  //   }

  //   // not an equality op, NaN
  //   if (!eqOp) return finalise(number(NaN));

  //   // else leave bool ops
  //   // todo: convert string to number if string and number/bool
  //   // todo: string (>|>=|<|<=) string

  //   // string comparison
  //   if (op === '===' || op === '==') {
  //     return finalise(compareStrings(scope, left, right));
  //   }

  //   if (op === '!==' || op === '!=') {
  //     return finalise([
  //       ...compareStrings(scope, left, right),
  //       [ Opcodes.i32_eqz ]
  //     ]);
  //   }
  // }

  let ops = operatorOpcode[valtype][op];

  // some complex ops are implemented as builtin funcs
  const builtinName = `${valtype}_${op}`;
  if (!ops && builtinFuncs[builtinName]) {
    includeBuiltin(scope, builtinName);
    const idx = funcIndex[builtinName];

    return finalise([
      ...left,
      ...right,
      [ Opcodes.call, idx ]
    ]);
  }

  if (!ops) return todo(`operator ${op} not implemented yet`); // throw new Error(`unknown operator ${op}`);

  if (!Array.isArray(ops)) ops = [ ops ];
  ops = [ ops ];

  let tmpLeft, tmpRight;
  // if equal op, check if strings for compareStrings
  if (op === '===' || op === '==' || op === '!==' || op === '!=') (() => {
    const knownLeft = knownType(scope, leftType);
    const knownRight = knownType(scope, rightType);

    // todo: intelligent partial skip later
    // if neither known are string, stop this madness
    if ((knownLeft != null && knownLeft !== TYPES.string) && (knownRight != null && knownRight !== TYPES.string)) {
      return;
    }

    tmpLeft = localTmp(scope, '__tmpop_left');
    tmpRight = localTmp(scope, '__tmpop_right');

    ops.unshift(...stringOnly([
      // if left is string
      ...leftType,
      ...number(TYPES.string, Valtype.i32),
      [ Opcodes.i32_eq ],

      // if right is string
      ...rightType,
      ...number(TYPES.string, Valtype.i32),
      [ Opcodes.i32_eq ],

      // if either are true
      [ Opcodes.i32_or ],
      [ Opcodes.if, Blocktype.void ],

      // todo: convert non-strings to strings, for now fail immediately if one is not
      // if left is not string
      ...leftType,
      ...number(TYPES.string, Valtype.i32),
      [ Opcodes.i32_ne ],

      // if right is not string
      ...rightType,
      ...number(TYPES.string, Valtype.i32),
      [ Opcodes.i32_ne ],

      // if either are true
      [ Opcodes.i32_or ],
      [ Opcodes.if, Blocktype.void ],
      ...number(0, Valtype.i32),
      [ Opcodes.br, 1 ],
      [ Opcodes.end ],

      ...compareStrings(scope, [ [ Opcodes.local_get, tmpLeft ] ], [ [ Opcodes.local_get, tmpRight ] ]),
      // ...compareStrings(scope, [ [ Opcodes.local_get, tmpLeft ] ], [ [ Opcodes.local_get, tmpRight ] ]),
      ...(op === '!==' || op === '!=' ? [ [ Opcodes.i32_eqz ] ] : []),
      [ Opcodes.br, 1 ],
      [ Opcodes.end ],
    ]));

    // if not already in block, add a block
    // if (endOut.length === 0) {
      startOut.push(stringOnly([ Opcodes.block, Valtype.i32 ]));
      // endOut.push(stringOnly([ Opcodes.end ]));
      endOut.unshift(stringOnly([ Opcodes.end ]));
    // }
  })();

  return finalise([
    ...left,
    ...(tmpLeft != null ? stringOnly([ [ Opcodes.local_tee, tmpLeft ] ]) : []),
    ...right,
    ...(tmpRight != null ? stringOnly([ [ Opcodes.local_tee, tmpRight ] ]) : []),
    ...ops
  ]);
};

const generateBinaryExp = (scope, decl, _global, _name) => {
  const out = performOp(scope, decl.operator, generate(scope, decl.left), generate(scope, decl.right), getNodeType(scope, decl.left), getNodeType(scope, decl.right), _global, _name);

  if (valtype !== 'i32' && ['==', '===', '!=', '!==', '>', '>=', '<', '<='].includes(decl.operator)) out.push(Opcodes.i32_from_u);

  return out;
};

const asmFunc = (name, { wasm, params, locals: localTypes, globals: globalTypes = [], globalInits, returns, returnType, localNames = [], globalNames = [] }) => {
  const existing = funcs.find(x => x.name === name);
  if (existing) return existing;

  const nameParam = i => localNames[i] ?? (i >= params.length ? ['a', 'b', 'c'][i - params.length] : ['x', 'y', 'z'][i]);

  const allLocals = params.concat(localTypes);
  const locals = {};
  for (let i = 0; i < allLocals.length; i++) {
    locals[nameParam(i)] = { idx: i, type: allLocals[i] };
  }

  let baseGlobalIdx, i = 0;
  for (const type of globalTypes) {
    if (baseGlobalIdx === undefined) baseGlobalIdx = globalInd;

    globals[globalNames[i] ?? `${name}_global_${i}`] = { idx: globalInd++, type, init: globalInits[i] ?? 0 };
    i++;
  }

  if (globalTypes.length !== 0) {
    // offset global ops for base global idx
    for (const inst of wasm) {
      if (inst[0] === Opcodes.global_get || inst[0] === Opcodes.global_set) {
        inst[1] += baseGlobalIdx;
      }
    }
  }

  const func = {
    name,
    params,
    locals,
    returns,
    returnType: TYPES[returnType ?? 'number'],
    wasm,
    internal: true,
    index: currentFuncIndex++
  };

  funcs.push(func);
  funcIndex[name] = func.index;

  return func;
};

const includeBuiltin = (scope, builtin) => {
  const code = builtinFuncs[builtin];
  if (code.wasm) return asmFunc(builtin, code);

  return code.body.map(x => generate(scope, x));
};

const generateLogicExp = (scope, decl) => {
  return performLogicOp(scope, decl.operator, generate(scope, decl.left), generate(scope, decl.right), getNodeType(scope, decl.left), getNodeType(scope, decl.right));
};

// T = JS type, V = value/pointer
// 0bTTT
// qNAN: 0 11111111111 1000000000000000000000000000000000000000000000000001
// 50 bits usable: 0 11111111111 11??????????????????????????????????????????????????
// js type: 4 bits
// internal type: ? bits
// pointer: 32 bits
// https://piotrduperas.com/posts/nan-boxing
// 0x7ffc000000000000
// budget: 50 bits
// js type: 4 bits
// internal type: ? bits
// pointer: 32 bits

// generic
// 1              23   4             5
// 0 11111111111 11TTTTIIII??????????PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP
// 1: regular iEEE 754 double NaN
// 2: extra 1 bit to identify NaN box
// 3: js type
// 4: internal type
// 5: pointer

const TYPES = {
  number: 0x00,
  boolean: 0x01,
  string: 0x02,
  undefined: 0x03,
  object: 0x04,
  function: 0x05,
  symbol: 0x06,
  bigint: 0x07,

  // these are not "typeof" types but tracked internally
  _array: 0x10,
  _regexp: 0x11
};

const TYPE_NAMES = {
  [TYPES.number]: 'Number',
  [TYPES.boolean]: 'Boolean',
  [TYPES.string]: 'String',
  [TYPES.undefined]: 'undefined',
  [TYPES.object]: 'Object',
  [TYPES.function]: 'Function',
  [TYPES.symbol]: 'Symbol',
  [TYPES.bigint]: 'BigInt',

  [TYPES._array]: 'Array',
  [TYPES._regexp]: 'RegExp'
};

const getType = (scope, _name) => {
  const name = mapName(_name);

  if (scope.locals[name]) return [ [ Opcodes.local_get, scope.locals[name + '#type'].idx ] ];
  if (globals[name]) return [ [ Opcodes.global_get, globals[name + '#type'].idx ] ];

  let type = TYPES.undefined;
  if (builtinVars[name]) type = TYPES[builtinVars[name].type ?? 'number'];
  if (builtinFuncs[name] !== undefined || importedFuncs[name] !== undefined || funcIndex[name] !== undefined || internalConstrs[name] !== undefined) type = TYPES.function;

  if (name.startsWith('__Array_prototype_') && prototypeFuncs[TYPES._array][name.slice(18)] ||
    name.startsWith('__String_prototype_') && prototypeFuncs[TYPES.string][name.slice(19)]) type = TYPES.function;

  return number(type, Valtype.i32);
};

const setType = (scope, _name, type) => {
  const name = mapName(_name);

  const out = typeof type === 'number' ? number(type, Valtype.i32) : type;

  if (typedInput && scope.locals[name]?.metadata?.type != null) return [];
  if (scope.locals[name]) return [
    ...out,
    [ Opcodes.local_set, scope.locals[name + '#type'].idx ]
  ];

  if (typedInput && globals[name]?.metadata?.type != null) return [];
  if (globals[name]) return [
    ...out,
    [ Opcodes.global_set, globals[name + '#type'].idx ]
  ];

  // throw new Error('could not find var');
};

const getLastType = scope => {
  scope.gotLastType = true;
  return [ Opcodes.local_get, localTmp(scope, '#last_type', Valtype.i32) ];
};

const setLastType = scope => {
  return [ Opcodes.local_set, localTmp(scope, '#last_type', Valtype.i32) ];
};

const getNodeType = (scope, node) => {
  const inner = () => {
    if (node.type === 'Literal') {
      if (node.regex) return TYPES._regexp;

      return TYPES[typeof node.value];
    }

    if (isFuncType(node.type)) {
      return TYPES.function;
    }

    if (node.type === 'Identifier') {
      return getType(scope, node.name);
    }

    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = node.callee.name;
      const func = funcs.find(x => x.name === name);

      if (func) {
        // console.log(scope, func, func.returnType);
        if (func.returnType) return func.returnType;
      }

      if (builtinFuncs[name]) return TYPES[builtinFuncs[name].returnType ?? 'number'];
      if (internalConstrs[name]) return internalConstrs[name].type;

      // check if this is a prototype function
      // if so and there is only one impl (eg charCodeAt)
      // use that return type as that is the only possibility
      // (if non-matching type it would error out)
      if (name.startsWith('__')) {
        const spl = name.slice(2).split('_');

        const func = spl[spl.length - 1];
        const protoFuncs = Object.values(prototypeFuncs).filter(x => x[func] != null);
        if (protoFuncs.length === 1) return protoFuncs[0].returnType ?? TYPES.number;
      }

      if (scope.locals['#last_type']) return [ getLastType(scope) ];

      // presume
      // todo: warn here?
      return TYPES.number;

      // let protoFunc;
      // // ident.func()
      // if (name && name.startsWith('__')) {
      //   const spl = name.slice(2).split('_');

      //   const baseName = spl.slice(0, -1).join('_');
      //   const baseType = getType(scope, baseName);

      //   const func = spl[spl.length - 1];
      //   protoFunc = prototypeFuncs[baseType]?.[func];
      // }

      // // literal.func()
      // if (!name && node.callee.type === 'MemberExpression') {
      //   if (node.callee.object.regex) {
      //     const funcName = node.callee.property.name;
      //     return Rhemyn[funcName] ? TYPES.boolean : TYPES.undefined;
      //   }

      //   const baseType = getNodeType(scope, node.callee.object);

      //   const func = node.callee.property.name;
      //   protoFunc = prototypeFuncs[baseType]?.[func];
      // }

      // if (protoFunc) return protoFunc.returnType;
    }

    if (node.type === 'ExpressionStatement') {
      return getNodeType(scope, node.expression);
    }

    if (node.type === 'AssignmentExpression') {
      return getNodeType(scope, node.right);
    }

    if (node.type === 'ArrayExpression') {
      return TYPES._array;
    }

    if (node.type === 'BinaryExpression') {
      if (['==', '===', '!=', '!==', '>', '>=', '<', '<='].includes(node.operator)) return TYPES.boolean;
      return TYPES.number;

      // todo: string concat types
      // if (node.operator !== '+') return TYPES.number;
      //   else return [
      //     // if left is string
      //     ...getNodeType(scope, node.left),
      //     ...number(TYPES.string, Valtype.i32),
      //     [ Opcodes.i32_eq ],

      //     // if right is string
      //     ...getNodeType(scope, node.right),
      //     ...number(TYPES.string, Valtype.i32),
      //     [ Opcodes.i32_eq ],

      //     // if either are true
      //     [ Opcodes.i32_or ],
      //   ];
    }

    if (node.type === 'UnaryExpression') {
      if (node.operator === '!') return TYPES.boolean;
      if (node.operator === 'void') return TYPES.undefined;
      if (node.operator === 'delete') return TYPES.boolean;
      if (node.operator === 'typeof') return TYPES.string;

      return TYPES.number;
    }

    if (node.type === 'MemberExpression') {
      // hack: if something.length, number type
      if (node.property.name === 'length') return TYPES.number;

      // we cannot guess
      return TYPES.number;
    }

    if (scope.locals['#last_type']) return [ getLastType(scope) ];

    // presume
    // todo: warn here?
    return TYPES.number;
  };

  const ret = inner();
  // console.trace(node, ret);
  if (typeof ret === 'number') return number(ret, Valtype.i32);
  return ret;
};

const generateLiteral = (scope, decl, global, name) => {
  if (decl.value === null) return number(NULL);

  if (decl.regex) {
    scope.regex[name] = decl.regex;
    return number(1);
  }

  switch (typeof decl.value) {
    case 'number':
      return number(decl.value);

    case 'boolean':
      // hack: bool as int (1/0)
      return number(decl.value ? 1 : 0);

    case 'string':
      const str = decl.value;
      const rawElements = new Array(str.length);
      let j = 0;
      for (let i = 0; i < str.length; i++) {
        rawElements[i] = str.charCodeAt(i);
      }

      return makeArray(scope, {
        rawElements
      }, global, name, false, 'i16')[0];

    default:
      return todo(`cannot generate literal of type ${typeof decl.value}`);
  }
};

const countLeftover = wasm => {
  let count = 0, depth = 0;

  for (let i = 0; i < wasm.length; i++) {
    const inst = wasm[i];
    if (depth === 0 && (inst[0] === Opcodes.if || inst[0] === Opcodes.block || inst[0] === Opcodes.loop)) {
      if (inst[0] === Opcodes.if) count--;
      if (inst[1] !== Blocktype.void) count++;
    }
    if ([Opcodes.if, Opcodes.try, Opcodes.loop, Opcodes.block].includes(inst[0])) depth++;
    if (inst[0] === Opcodes.end) depth--;

    if (depth === 0)
      if ([Opcodes.throw,Opcodes.drop, Opcodes.local_set, Opcodes.global_set].includes(inst[0])) count--;
        else if ([null, Opcodes.i32_eqz, Opcodes.i64_eqz, Opcodes.f64_ceil, Opcodes.f64_floor, Opcodes.f64_trunc, Opcodes.f64_nearest, Opcodes.f64_sqrt, Opcodes.local_tee, Opcodes.i32_wrap_i64, Opcodes.i64_extend_i32_s, Opcodes.i64_extend_i32_u, Opcodes.f32_demote_f64, Opcodes.f64_promote_f32, Opcodes.f64_convert_i32_s, Opcodes.f64_convert_i32_u, Opcodes.i32_clz, Opcodes.i32_ctz, Opcodes.i32_popcnt, Opcodes.f64_neg, Opcodes.end, Opcodes.i32_trunc_sat_f64_s[0], Opcodes.i32x4_extract_lane, Opcodes.i16x8_extract_lane, Opcodes.i32_load, Opcodes.i64_load, Opcodes.f64_load, Opcodes.v128_load, Opcodes.i32_load16_u, Opcodes.i32_load16_s, Opcodes.memory_grow].includes(inst[0]) && (inst[0] !== 0xfc || inst[1] < 0x0a)) {}
        else if ([Opcodes.local_get, Opcodes.global_get, Opcodes.f64_const, Opcodes.i32_const, Opcodes.i64_const, Opcodes.v128_const].includes(inst[0])) count++;
        else if ([Opcodes.i32_store, Opcodes.i64_store, Opcodes.f64_store, Opcodes.i32_store16].includes(inst[0])) count -= 2;
        else if (Opcodes.memory_copy[0] === inst[0] && Opcodes.memory_copy[1] === inst[1]) count -= 3;
        else if (inst[0] === Opcodes.return) count = 0;
        else if (inst[0] === Opcodes.call) {
          let func = funcs.find(x => x.index === inst[1]);
          if (func) {
            count -= func.params.length;
          } else count--;
          if (func) count += func.returns.length;
        } else count--;

    // console.log(count, decompile([ inst ]).slice(0, -1));
  }

  return count;
};

const disposeLeftover = wasm => {
  let leftover = countLeftover(wasm);

  for (let i = 0; i < leftover; i++) wasm.push([ Opcodes.drop ]);
};

const generateExp = (scope, decl) => {
  const expression = decl.expression;

  const out = generate(scope, expression);
  disposeLeftover(out);

  return out;
};

const CTArrayUtil = {
  getLengthI32: pointer => [
    ...number(0, Valtype.i32),
    [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ]
  ],

  getLength: pointer => [
    ...number(0, Valtype.i32),
    [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ],
    Opcodes.i32_from_u
  ],

  setLengthI32: (pointer, value) => [
    ...number(0, Valtype.i32),
    ...value,
    [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ]
  ],

  setLength: (pointer, value) => [
    ...number(0, Valtype.i32),
    ...value,
    Opcodes.i32_to_u,
    [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ]
  ]
};

const RTArrayUtil = {
  getLengthI32: pointer => [
    ...pointer,
    [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, 0 ]
  ],

  getLength: pointer => [
    ...pointer,
    [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, 0 ],
    Opcodes.i32_from_u
  ],

  setLengthI32: (pointer, value) => [
    ...pointer,
    ...value,
    [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, 0 ]
  ],

  setLength: (pointer, value) => [
    ...pointer,
    ...value,
    Opcodes.i32_to_u,
    [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, 0 ]
  ]
};

const generateCall = (scope, decl, _global, _name) => {
  /* const callee = decl.callee;
  const args = decl.arguments;

  return [
    ...generate(args),
    ...generate(callee),
    Opcodes.call_indirect,
  ]; */

  let name = mapName(decl.callee.name);
  if (isFuncType(decl.callee.type)) { // iife
    const func = generateFunc(scope, decl.callee);
    name = func.name;
  }

  if (name === 'eval' && decl.arguments[0].type === 'Literal') {
    // literal eval hack
    const code = decl.arguments[0].value;
    const parsed = parse(code, []);

    const out = generate(scope, {
      type: 'BlockStatement',
      body: parsed.body
    });

    const lastInst = out[out.length - 1];
    if (lastInst && lastInst[0] === Opcodes.drop) {
      out.splice(out.length - 1, 1);

      const finalStatement = parsed.body[parsed.body.length - 1];
      out.push(
        ...getNodeType(scope, finalStatement),
        setLastType(scope)
      );
    } else if (countLeftover(out) === 0) {
      out.push(...number(UNDEFINED));
      out.push(
        ...number(TYPES.undefined, Valtype.i32),
        setLastType(scope)
      );
    }

    // if (lastInst && lastInst[0] === Opcodes.drop) {
    //   out.splice(out.length - 1, 1);
    // } else if (countLeftover(out) === 0) {
    //   out.push(...number(UNDEFINED));
    // }

    return out;
  }

  let protoName, target;
  // ident.func()
  if (name && name.startsWith('__')) {
    const spl = name.slice(2).split('_');

    protoName = spl[spl.length - 1];

    target = { ...decl.callee };
    target.name = spl.slice(0, -1).join('_');
  }

  // literal.func()
  if (!name && decl.callee.type === 'MemberExpression') {
    // megahack for /regex/.func()
    if (decl.callee.object.regex) {
      const funcName = decl.callee.property.name;
      const func = Rhemyn[funcName](decl.callee.object.regex.pattern, currentFuncIndex++);

      funcIndex[func.name] = func.index;
      funcs.push(func);

      return [
        // make string arg
        ...generate(scope, decl.arguments[0]),

        // call regex func
        Opcodes.i32_to_u,
        [ Opcodes.call, func.index ],
        Opcodes.i32_from_u,

        ...number(TYPES.boolean, Valtype.i32),
        setLastType(scope)
      ];
    }

    protoName = decl.callee.property.name;

    target = decl.callee.object;
  }

  // if (protoName && baseType === TYPES.string && Rhemyn[protoName]) {
  //   const func = Rhemyn[protoName](decl.arguments[0].regex.pattern, currentFuncIndex++);

  //   funcIndex[func.name] = func.index;
  //   funcs.push(func);

  //   return [
  //     generate(scope, decl.callee.object)

  //     // call regex func
  //     [ Opcodes.call, func.index ],
  //     Opcodes.i32_from_u
  //   ];
  // }

  if (protoName) {
    const protoCands = Object.keys(prototypeFuncs).reduce((acc, x) => {
      const f = prototypeFuncs[x][protoName];
      if (f) acc[x] = f;
      return acc;
    }, {});

    // no prototype function candidates, ignore
    if (Object.keys(protoCands).length > 0) {
      // use local for cached i32 length as commonly used
      const lengthLocal = localTmp(scope, '__proto_length_cache', Valtype.i32);
      const pointerLocal = localTmp(scope, '__proto_pointer_cache', Valtype.i32);
      const getPointer = [ [ Opcodes.local_get, pointerLocal ] ];

      // TODO: long-term, prototypes should be their individual separate funcs

      let lengthI32CacheUsed = false;
      const protoBC = {};
      for (const x in protoCands) {
        const protoFunc = protoCands[x];
        if (protoFunc.noArgRetLength && decl.arguments.length === 0) {
          protoBC[x] = [
            ...RTArrayUtil.getLength(getPointer),

            ...number(TYPES.number, Valtype.i32),
            setLastType(scope)
          ];
          continue;
        }

        // const protoLocal = protoFunc.local ? localTmp(scope, `__${TYPE_NAMES[x]}_${protoName}_tmp`, protoFunc.local) : -1;
        // const protoLocal2 = protoFunc.local2 ? localTmp(scope, `__${TYPE_NAMES[x]}_${protoName}_tmp2`, protoFunc.local2) : -1;
        const protoLocal = protoFunc.local ? localTmp(scope, `__${protoName}_tmp`, protoFunc.local) : -1;
        const protoLocal2 = protoFunc.local2 ? localTmp(scope, `__${protoName}_tmp2`, protoFunc.local2) : -1;

        const protoOut = protoFunc(getPointer, {
          getCachedI32: () => {
            lengthI32CacheUsed = true;
            return [ [ Opcodes.local_get, lengthLocal ] ];
          },
          setCachedI32: () => [ [ Opcodes.local_set, lengthLocal ] ],
          get: () => RTArrayUtil.getLength(getPointer),
          getI32: () => RTArrayUtil.getLengthI32(getPointer),
          set: value => RTArrayUtil.setLength(getPointer, value),
          setI32: value => RTArrayUtil.setLengthI32(getPointer, value)
        }, generate(scope, decl.arguments[0] ?? DEFAULT_VALUE), protoLocal, protoLocal2, (length, itemType) => {
          return makeArray(scope, {
            rawElements: new Array(length)
          }, _global, _name, true, itemType);
        });

        protoBC[x] = [
          [ Opcodes.block, valtypeBinary ],
          ...protoOut,

          ...number(protoFunc.returnType ?? TYPES.number, Valtype.i32),
          setLastType(scope),
          [ Opcodes.end ]
        ];
      }

      return [
        ...generate(scope, target),

        Opcodes.i32_to_u,
        [ Opcodes.local_set, pointerLocal ],

        ...(!lengthI32CacheUsed ? [] : [
          ...RTArrayUtil.getLengthI32(getPointer),
          [ Opcodes.local_set, lengthLocal ],
        ]),

        ...typeSwitch(scope, getNodeType(scope, target), {
          ...protoBC,

          // TODO: error better
          default: internalThrow(scope, 'TypeError', `'${protoName}' proto func tried to be called on a type without an impl`)
        }, valtypeBinary),
      ];
    }
  }

  // TODO: only allows callee as literal
  if (!name) return todo(`only literal callees (got ${decl.callee.type})`);

  let idx = funcIndex[name] ?? importedFuncs[name];
  if (idx === undefined && builtinFuncs[name]) {
    if (builtinFuncs[name].floatOnly && valtype !== 'f64') throw new Error(`Cannot use built-in ${unhackName(name)} with integer valtype`);

    includeBuiltin(scope, name);
    idx = funcIndex[name];

    // infer arguments types from builtins params
    const func = funcs.find(x => x.name === name);
    for (let i = 0; i < decl.arguments.length; i++) {
      const arg = decl.arguments[i];
      if (!arg.name) continue;

      const local = scope.locals[arg.name];
      if (!local) continue;

      local.type = func.params[i];
      if (local.type === Valtype.v128) {
        // specify vec subtype inferred from last vec type in function name
        local.vecType = name.split('_').reverse().find(x => x.includes('x'));
      }
    }
  }

  if (idx === undefined && internalConstrs[name]) return internalConstrs[name].generate(scope, decl, _global, _name);

  if (idx === undefined && name === scope.name) {
    // hack: calling self, func generator will fix later
    idx = -1;
  }

  if (idx === undefined) {
    if (scope.locals[name] !== undefined || globals[name] !== undefined || builtinVars[name] !== undefined) return internalThrow(scope, 'TypeError', `${unhackName(name)} is not a function`);
    return internalThrow(scope, 'ReferenceError', `${unhackName(name)} is not defined`);
  }

  const func = funcs.find(x => x.index === idx);

  const userFunc = (funcIndex[name] && !importedFuncs[name] && !builtinFuncs[name] && !internalConstrs[name]) || idx === -1;
  const typedParams = userFunc || builtinFuncs[name]?.typedParams;
  const typedReturn = userFunc || builtinFuncs[name]?.typedReturn;
  const paramCount = func && (typedParams ? func.params.length / 2 : func.params.length);

  let args = decl.arguments;
  if (func && args.length < paramCount) {
    // too little args, push undefineds
    args = args.concat(new Array(paramCount - args.length).fill(DEFAULT_VALUE));
  }

  if (func && args.length > paramCount) {
    // too many args, slice extras off
    args = args.slice(0, paramCount);
  }

  if (func && func.throws) scope.throws = true;

  let out = [];
  for (const arg of args) {
    out = out.concat(generate(scope, arg));
    if (typedParams) out = out.concat(getNodeType(scope, arg));
  }

  out.push([ Opcodes.call, idx ]);

  if (!typedReturn) {
    // let type;
    // if (builtinFuncs[name]) type = TYPES[builtinFuncs[name].returnType ?? 'number'];
    // if (internalConstrs[name]) type = internalConstrs[name].type;
    // if (importedFuncs[name] && importedFuncs[]) type =

    // if (type) out.push(
    //   ...number(type, Valtype.i32),
    //   [ Opcodes.local_set, localTmp(scope, '#last_type', Valtype.i32) ]
    // );
  } else out.push(setLastType(scope));

  return out;
};

const generateNew = (scope, decl, _global, _name) => {
  // hack: basically treat this as a normal call for builtins for now
  const name = mapName(decl.callee.name);
  if (internalConstrs[name] && !internalConstrs[name].notConstr) return internalConstrs[name].generate(scope, decl, _global, _name);
  if (!builtinFuncs[name]) return todo(`new statement is not supported yet`); // return todo(`new statement is not supported yet (new ${unhackName(name)})`);

  return generateCall(scope, decl, _global, _name);
};

// bad hack for undefined and null working without additional logic
const DEFAULT_VALUE = {
  type: 'Identifier',
  name: 'undefined'
};

const unhackName = name => {
  if (name.startsWith('__')) return name.slice(2).replaceAll('_', '.');
  return name;
};

const knownType = (scope, type) => {
  if (type.length === 1 && type[0][0] === Opcodes.i32_const) {
    return type[0][1];
  }

  if (typedInput && type.length === 1 && type[0][0] === Opcodes.local_get) {
    const idx = type[0][1];

    // type idx = var idx + 1
    const v = Object.values(scope.locals).find(x => x.idx === idx - 1);
    if (v.metadata?.type != null) return v.metadata.type;
  }

  return null;
};

const brTable = (input, bc, returns) => {
  const out = [];
  const keys = Object.keys(bc);
  const count = keys.length;

  if (count === 1) {
    // return [
    //   ...input,
    //   ...bc[keys[0]]
    // ];
    return bc[keys[0]];
  }

  if (count === 2) {
    // just use if else
    const other = keys.find(x => x !== 'default');
    return [
      ...input,
      ...number(other, Valtype.i32),
      [ Opcodes.i32_eq ],
      [ Opcodes.if, returns ],
      ...bc[other],
      [ Opcodes.else ],
      ...bc.default,
      [ Opcodes.end ]
    ];
  }

  for (let i = 0; i < count; i++) {
    if (i === 0) out.push([ Opcodes.block, returns, 'br table start' ]);
      else out.push([ Opcodes.block, Blocktype.void ]);
  }

  const nums = keys.filter(x => +x);
  const offset = Math.min(...nums);
  const max = Math.max(...nums);

  const table = [];
  let br = 1;

  for (let i = offset; i <= max; i++) {
    // if branch for this num, go to that block
    if (bc[i]) {
      table.push(br);
      br++;
      continue;
    }

    // else default
    table.push(0);
  }

  out.push(
    [ Opcodes.block, Blocktype.void ],
    ...input,
    ...(offset > 0 ? [
      ...number(offset, Valtype.i32),
      [ Opcodes.i32_sub ]
    ] : []),
    [ Opcodes.br_table, ...encodeVector(table), 0 ]
  );

  // if you can guess why we sort the wrong way and then reverse
  // (instead of just sorting the correct way)
  // dm me and if you are correct and the first person
  // I will somehow shout you out or something
  const orderedBc = keys.sort((a, b) => b - a).reverse();

  br = count - 1;
  for (const x of orderedBc) {
    out.push(
      [ Opcodes.end ],
      ...bc[x],
      ...(br === 0 ? [] : [ [ Opcodes.br, br ] ])
    );
    br--;
  }

  return [
    ...out,
    [ Opcodes.end, 'br table end' ]
  ];
};

const typeSwitch = (scope, type, bc, returns = valtypeBinary) => {
  const known = knownType(scope, type);
  if (known != null) {
    return bc[known] ?? bc.default;
  }

  if (process.argv.includes('-typeswitch-use-brtable'))
    return brTable(type, bc, returns);

  const tmp = localTmp(scope, '#typeswitch_tmp', Valtype.i32);
  const out = [
    ...type,
    [ Opcodes.local_set, tmp ],
    [ Opcodes.block, returns ]
  ];

  // todo: use br_table?

  for (const x in bc) {
    if (x === 'default') continue;

    // if type == x
    out.push([ Opcodes.local_get, tmp ]);
    out.push(...number(x, Valtype.i32));
    out.push([ Opcodes.i32_eq ]);

    out.push([ Opcodes.if, Blocktype.void, `TYPESWITCH|${TYPE_NAMES[x]}` ]);
    out.push(...bc[x]);
    out.push([ Opcodes.br, 1 ]);
    out.push([ Opcodes.end ]);
  }

  // default
  if (bc.default) out.push(...bc.default);
    else if (returns !== Blocktype.void) out.push(...number(0, returns));

  out.push([ Opcodes.end, 'TYPESWITCH_end' ]);

  return out;
};

const allocVar = (scope, name, global = false) => {
  const target = global ? globals : scope.locals;

  // already declared
  if (target[name]) {
    // parser should catch this but sanity check anyway
    // if (decl.kind !== 'var') return internalThrow(scope, 'SyntaxError', `Identifier '${unhackName(name)}' has already been declared`);

    return target[name].idx;
  }

  let idx = global ? globalInd++ : scope.localInd++;
  target[name] = { idx, type: valtypeBinary };

  let typeIdx = global ? globalInd++ : scope.localInd++;
  target[name + '#type'] = { idx: typeIdx, type: Valtype.i32 };

  return idx;
};

const addVarMetadata = (scope, name, global = false, metadata = {}) => {
  const target = global ? globals : scope.locals;

  target[name].metadata ??= {};
  for (const x in metadata) {
    if (metadata[x] != null) target[name].metadata[x] = metadata[x];
  }
};

const typeAnnoToPorfType = x => {
  if (TYPES[x]) return TYPES[x];
  if (TYPES['_' + x]) return TYPES['_' + x];

  switch (x) {
    case 'i32':
      return TYPES.number;
  }

  return null;
};

const extractTypeAnnotation = decl => {
  let a = decl;
  while (a.typeAnnotation) a = a.typeAnnotation;

  let type, elementType;
  if (a.typeName) {
    type = a.typeName.name;
  } else if (a.type.endsWith('Keyword')) {
    type = a.type.slice(2, -7).toLowerCase();
  } else if (a.type === 'TSArrayType') {
    type = 'array';
    elementType = extractTypeAnnotation(a.elementType).type;
  }

  const typeName = type;
  type = typeAnnoToPorfType(type);

  // if (decl.name) console.log(decl.name, { type, elementType });

  return { type, typeName, elementType };
};

const generateVar = (scope, decl) => {
  let out = [];

  const topLevel = scope.name === 'main';

  // global variable if in top scope (main) and var ..., or if wanted
  const global = topLevel || decl._bare; // decl.kind === 'var';

  for (const x of decl.declarations) {
    const name = mapName(x.id.name);

    if (x.init && isFuncType(x.init.type)) {
      // hack for let a = function () { ... }
      x.init.id = { name };
      generateFunc(scope, x.init);
      continue;
    }

    // console.log(name);
    if (topLevel && builtinVars[name]) {
      // cannot redeclare
      if (decl.kind !== 'var') return internalThrow(scope, 'SyntaxError', `Identifier '${unhackName(name)}' has already been declared`);

      continue; // always ignore
    }

    let idx = allocVar(scope, name, global);

    if (typedInput && x.id.typeAnnotation) {
      addVarMetadata(scope, name, global, extractTypeAnnotation(x.id));
    }

    if (x.init) {
      out = out.concat(generate(scope, x.init, global, name));

      out.push([ global ? Opcodes.global_set : Opcodes.local_set, idx ]);
      out.push(...setType(scope, name, getNodeType(scope, x.init)));
    }

    // hack: this follows spec properly but is mostly unneeded 😅
    // out.push(...setType(scope, name, x.init ? getNodeType(scope, x.init) : TYPES.undefined));
  }

  return out;
};

const generateAssign = (scope, decl) => {
  const { type, name } = decl.left;

  if (type === 'ObjectPattern') {
    // hack: ignore object parts of `var a = {} = 2`
    return generate(scope, decl.right);
  }

  if (isFuncType(decl.right.type)) {
    // hack for a = function () { ... }
    decl.right.id = { name };
    generateFunc(scope, decl.right);
    return [];
  }

  // hack: .length setter
  if (decl.left.type === 'MemberExpression' && decl.left.property.name === 'length') {
    const name = decl.left.object.name;
    const pointer = arrays.get(name);

    const aotPointer = pointer != null;

    const newValueTmp = localTmp(scope, '__length_setter_tmp');

    return [
      ...(aotPointer ? number(0, Valtype.i32) : [
        ...generate(scope, decl.left.object),
        Opcodes.i32_to_u
      ]),

      ...generate(scope, decl.right),
      [ Opcodes.local_tee, newValueTmp ],

      Opcodes.i32_to_u,
      [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(aotPointer ? pointer : 0) ],

      [ Opcodes.local_get, newValueTmp ]
    ];
  }

  const op = decl.operator.slice(0, -1) || '=';

  // arr[i]
  if (decl.left.type === 'MemberExpression' && decl.left.computed) {
    const name = decl.left.object.name;
    const pointer = arrays.get(name);

    const aotPointer = pointer != null;

    const newValueTmp = localTmp(scope, '__member_setter_val_tmp');
    const pointerTmp = op === '=' ? -1 : localTmp(scope, '__member_setter_ptr_tmp', Valtype.i32);

    return [
      ...typeSwitch(scope, getNodeType(scope, decl.left.object), {
        [TYPES._array]: [
          ...(aotPointer ? [] : [
            ...generate(scope, decl.left.object),
            Opcodes.i32_to_u
          ]),

          // get index as valtype
          ...generate(scope, decl.left.property),
          Opcodes.i32_to_u,

          // turn into byte offset by * valtypeSize (4 for i32, 8 for i64/f64)
          ...number(ValtypeSize[valtype], Valtype.i32),
          [ Opcodes.i32_mul ],
          ...(aotPointer ? [] : [ [ Opcodes.i32_add ] ]),
          ...(op === '=' ? [] : [ [ Opcodes.local_tee, pointerTmp ] ]),

          ...(op === '=' ? generate(scope, decl.right) : performOp(scope, op, [
            [ Opcodes.local_get, pointerTmp ],
            [ Opcodes.load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128((aotPointer ? pointer : 0) + ValtypeSize.i32) ]
          ], generate(scope, decl.right), number(TYPES.number, Valtype.i32), getNodeType(scope, decl.right), false, name, true)),
          [ Opcodes.local_tee, newValueTmp ],

          [ Opcodes.store, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128((aotPointer ? pointer : 0) + ValtypeSize.i32) ]
        ],

        default: internalThrow(scope, 'TypeError', `Cannot assign member with non-array`)

        // [TYPES.string]: [
        //   // turn into byte offset by * sizeof i16
        //   ...number(ValtypeSize.i16, Valtype.i32),
        //   [ Opcodes.i32_mul ],
        //   ...(aotPointer ? [] : [ [ Opcodes.i32_add ] ]),
        //   ...(op === '=' ? [] : [ [ Opcodes.local_tee, pointerTmp ] ]),

        //   ...(op === '=' ? generate(scope, decl.right) : performOp(scope, op, [
        //     [ Opcodes.local_get, pointerTmp ],
        //     [ Opcodes.load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128((aotPointer ? pointer : 0) + ValtypeSize.i32) ]
        //   ], generate(scope, decl.right), number(TYPES.string, Valtype.i32), getNodeType(scope, decl.right))),
        //   [ Opcodes.local_tee, newValueTmp ],

        //   Opcodes.i32_to_u,
        //   [ StoreOps.i16, Math.log2(ValtypeSize.i16) - 1, ...unsignedLEB128((aotPointer ? pointer : 0) + ValtypeSize.i32) ]
        // ]
      }, Blocktype.void),

      [ Opcodes.local_get, newValueTmp ]
    ];
  }

  const [ local, isGlobal ] = lookupName(scope, name);

  if (local === undefined) {
    // todo: this should be a sloppy mode only thing

    // only allow = for this
    if (op !== '=') return internalThrow(scope, 'ReferenceError', `${unhackName(name)} is not defined`);

    if (builtinVars[name]) {
      // just return rhs (eg `NaN = 2`)
      return generate(scope, decl.right);
    }

    // set global and return (eg a = 2)
    return [
      ...generateVar(scope, { kind: 'var', _bare: true, declarations: [ { id: { name }, init: decl.right } ] }),
      [ Opcodes.global_get, globals[name].idx ]
    ];
  }

  if (op === '=') {
    return [
      ...generate(scope, decl.right, isGlobal, name),
      [ isGlobal ? Opcodes.global_set : Opcodes.local_set, local.idx ],
      [ isGlobal ? Opcodes.global_get : Opcodes.local_get, local.idx ],

      ...setType(scope, name, getNodeType(scope, decl.right))
    ];
  }

  if (op === '||' || op === '&&' || op === '??') {
    // todo: is this needed?
    // for logical assignment ops, it is not left @= right ~= left = left @ right
    // instead, left @ (left = right)
    // eg, x &&= y ~= x && (x = y)

    return [
      ...performOp(scope, op, [
        [ isGlobal ? Opcodes.global_get : Opcodes.local_get, local.idx ]
      ], [
        ...generate(scope, decl.right),
        [ isGlobal ? Opcodes.global_set : Opcodes.local_set, local.idx ],
        [ isGlobal ? Opcodes.global_get : Opcodes.local_get, local.idx ]
      ], getType(scope, name), getNodeType(scope, decl.right), isGlobal, name, true),
      [ isGlobal ? Opcodes.global_get : Opcodes.local_get, local.idx ],

      getLastType(scope),
      // hack: type is idx+1
      [ isGlobal ? Opcodes.global_set : Opcodes.local_set, local.idx + 1 ],
    ];
  }

  return [
    ...performOp(scope, op, [ [ isGlobal ? Opcodes.global_get : Opcodes.local_get, local.idx ] ], generate(scope, decl.right), getType(scope, name), getNodeType(scope, decl.right), isGlobal, name, true),
    [ isGlobal ? Opcodes.global_set : Opcodes.local_set, local.idx ],
    [ isGlobal ? Opcodes.global_get : Opcodes.local_get, local.idx ],

    // todo: string concat types

    // hack: type is idx+1
    ...number(TYPES.number, Valtype.i32),
    [ isGlobal ? Opcodes.global_set : Opcodes.local_set, local.idx + 1 ],
  ];
};

const generateUnary = (scope, decl) => {
  switch (decl.operator) {
    case '+':
      // stub
      return generate(scope, decl.argument);

    case '-':
      // * -1

      if (decl.prefix && decl.argument.type === 'Literal' && typeof decl.argument.value === 'number') {
        // if -<N>, just return that
        return number(-1 * decl.argument.value);
      }

      return [
        ...generate(scope, decl.argument),
        ...(valtype === 'f64' ? [ [ Opcodes.f64_neg ] ] : [ ...number(-1), [ Opcodes.mul ] ])
      ];

    case '!':
      // !=
      return falsy(scope, generate(scope, decl.argument), getNodeType(scope, decl.argument), false, false);

    case '~':
      // todo: does not handle Infinity properly (should convert to 0) (but opt const converting saves us sometimes)
      return [
        ...generate(scope, decl.argument),
        Opcodes.i32_to,
        [ Opcodes.i32_const, ...signedLEB128(-1) ],
        [ Opcodes.i32_xor ],
        Opcodes.i32_from
      ];

    case 'void': {
      // drop current expression value after running, give undefined
      const out = generate(scope, decl.argument);
      disposeLeftover(out);

      out.push(...number(UNDEFINED));
      return out;
    }

    case 'delete':
      let toReturn = true, toGenerate = true;

      if (decl.argument.type === 'Identifier') {
        const out = generateIdent(scope, decl.argument);

        // if ReferenceError (undeclared var), ignore and return true. otherwise false
        if (!out[1]) {
          // exists
          toReturn = false;
        } else {
          // does not exist (2 ops from throw)
          toReturn = true;
          toGenerate = false;
        }
      }

      const out = toGenerate ? generate(scope, decl.argument) : [];
      disposeLeftover(out);

      out.push(...number(toReturn ? 1 : 0));
      return out;

    case 'typeof':
      return typeSwitch(scope, getNodeType(scope, decl.argument), {
        [TYPES.number]: makeString(scope, 'number', false, '#typeof_result'),
        [TYPES.boolean]: makeString(scope, 'boolean', false, '#typeof_result'),
        [TYPES.string]: makeString(scope, 'string', false, '#typeof_result'),
        [TYPES.undefined]: makeString(scope, 'undefined', false, '#typeof_result'),
        [TYPES.function]: makeString(scope, 'function', false, '#typeof_result'),

        // object and internal types
        default: makeString(scope, 'object', false, '#typeof_result'),
      });

    default:
      return todo(`unary operator ${decl.operator} not implemented yet`);
  }
};

const generateUpdate = (scope, decl) => {
  const { name } = decl.argument;

  const [ local, isGlobal ] = lookupName(scope, name);

  if (local === undefined) {
    return todo(`update expression with undefined variable`);
  }

  const idx = local.idx;
  const out = [];

  out.push([ isGlobal ? Opcodes.global_get : Opcodes.local_get, idx ]);
  if (!decl.prefix) out.push([ isGlobal ? Opcodes.global_get : Opcodes.local_get, idx ]);

  switch (decl.operator) {
    case '++':
      out.push(...number(1), [ Opcodes.add ]);
      break;

    case '--':
      out.push(...number(1), [ Opcodes.sub ]);
      break;
  }

  out.push([ isGlobal ? Opcodes.global_set : Opcodes.local_set, idx ]);
  if (decl.prefix) out.push([ isGlobal ? Opcodes.global_get : Opcodes.local_get, idx ]);

  return out;
};

const generateIf = (scope, decl) => {
  const out = truthy(scope, generate(scope, decl.test), getNodeType(scope, decl.test), false, true);

  out.push([ Opcodes.if, Blocktype.void ]);
  depth.push('if');

  const consOut = generate(scope, decl.consequent);
  disposeLeftover(consOut);
  out.push(...consOut);

  if (decl.alternate) {
    out.push([ Opcodes.else ]);

    const altOut = generate(scope, decl.alternate);
    disposeLeftover(altOut);
    out.push(...altOut);
  }

  out.push([ Opcodes.end ]);
  depth.pop();

  return out;
};

const generateConditional = (scope, decl) => {
  const out = truthy(scope, generate(scope, decl.test), getNodeType(scope, decl.test), false, true);

  out.push([ Opcodes.if, valtypeBinary ]);
  depth.push('if');

  out.push(...generate(scope, decl.consequent));

  // note type
  out.push(
    ...getNodeType(scope, decl.consequent),
    setLastType(scope)
  );

  out.push([ Opcodes.else ]);
  out.push(...generate(scope, decl.alternate));

  // note type
  out.push(
    ...getNodeType(scope, decl.alternate),
    setLastType(scope)
  );

  out.push([ Opcodes.end ]);
  depth.pop();

  return out;
};

let depth = [];
const generateFor = (scope, decl) => {
  const out = [];

  if (decl.init) {
    out.push(...generate(scope, decl.init));
    disposeLeftover(out);
  }

  out.push([ Opcodes.loop, Blocktype.void ]);
  depth.push('for');

  out.push(...generate(scope, decl.test));
  out.push(Opcodes.i32_to, [ Opcodes.if, Blocktype.void ]);
  depth.push('if');

  out.push([ Opcodes.block, Blocktype.void ]);
  depth.push('block');
  out.push(...generate(scope, decl.body));
  out.push([ Opcodes.end ]);

  out.push(...generate(scope, decl.update));
  depth.pop();

  out.push([ Opcodes.br, 1 ]);
  out.push([ Opcodes.end ], [ Opcodes.end ]);
  depth.pop(); depth.pop();

  return out;
};

const generateWhile = (scope, decl) => {
  const out = [];

  out.push([ Opcodes.loop, Blocktype.void ]);
  depth.push('while');

  out.push(...generate(scope, decl.test));
  out.push(Opcodes.i32_to, [ Opcodes.if, Blocktype.void ]);
  depth.push('if');

  out.push(...generate(scope, decl.body));

  out.push([ Opcodes.br, 1 ]);
  out.push([ Opcodes.end ], [ Opcodes.end ]);
  depth.pop(); depth.pop();

  return out;
};

const generateForOf = (scope, decl) => {
  const out = [];

  // todo: for of inside for of might fuck up?
  const pointer = localTmp(scope, 'forof_base_pointer', Valtype.i32);
  const length = localTmp(scope, 'forof_length', Valtype.i32);
  const counter = localTmp(scope, 'forof_counter', Valtype.i32);

  out.push(
    // set pointer as right
    ...generate(scope, decl.right),
    Opcodes.i32_to_u,
    [ Opcodes.local_set, pointer ],

    // set counter as 0 (could be already used)
    ...number(0, Valtype.i32),
    [ Opcodes.local_set, counter ],

    // get length
    [ Opcodes.local_get, pointer ],
    [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, 0 ],
    [ Opcodes.local_set, length ]
  );

  depth.push('forof');

  // setup local for left
  generate(scope, decl.left);

  const leftName = decl.left.declarations[0].id.name;
  const [ local, isGlobal ] = lookupName(scope, leftName);

  depth.push('block');
  depth.push('block');

  // // todo: we should only do this for strings but we don't know at compile-time :(
  // hack: this is naughty and will break things!
  let newOut = number(0, Valtype.f64), newPointer = -1;
  if (pages.hasString) {
    0, [ newOut, newPointer ] = makeArray(scope, {
      rawElements: new Array(1)
    }, isGlobal, leftName, true, 'i16');
  }

  // set type for local
  out.push(...typeSwitch(scope, getNodeType(scope, decl.right), {
    [TYPES._array]: [
      ...setType(scope, leftName, TYPES.number),

      [ Opcodes.loop, Blocktype.void ],

      [ Opcodes.local_get, pointer ],
      [ Opcodes.load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128(ValtypeSize.i32) ],

      [ isGlobal ? Opcodes.global_set : Opcodes.local_set, local.idx ],

      [ Opcodes.block, Blocktype.void ],
      [ Opcodes.block, Blocktype.void ],
      ...generate(scope, decl.body),
      [ Opcodes.end ],

      // increment iter pointer by valtype size
      [ Opcodes.local_get, pointer ],
      ...number(ValtypeSize[valtype], Valtype.i32),
      [ Opcodes.i32_add ],
      [ Opcodes.local_set, pointer ],

      // increment counter by 1
      [ Opcodes.local_get, counter ],
      ...number(1, Valtype.i32),
      [ Opcodes.i32_add ],
      [ Opcodes.local_tee, counter ],

      // loop if counter != length
      [ Opcodes.local_get, length ],
      [ Opcodes.i32_ne ],
      [ Opcodes.br_if, 1 ],

      [ Opcodes.end ],
      [ Opcodes.end ]
    ],
    [TYPES.string]: [
      ...setType(scope, leftName, TYPES.string),

      [ Opcodes.loop, Blocktype.void ],

      // setup new/out array
      ...newOut,
      [ Opcodes.drop ],

      ...number(0, Valtype.i32), // base 0 for store after

      // load current string ind {arg}
      [ Opcodes.local_get, pointer ],
      [ Opcodes.i32_load16_u, Math.log2(ValtypeSize.i16) - 1, ...unsignedLEB128(ValtypeSize.i32) ],

      // store to new string ind 0
      [ Opcodes.i32_store16, Math.log2(ValtypeSize.i16) - 1, ...unsignedLEB128(newPointer + ValtypeSize.i32) ],

      // return new string (page)
      ...number(newPointer),

      [ isGlobal ? Opcodes.global_set : Opcodes.local_set, local.idx ],

      [ Opcodes.block, Blocktype.void ],
      [ Opcodes.block, Blocktype.void ],
      ...generate(scope, decl.body),
      [ Opcodes.end ],

      // increment iter pointer by valtype size
      [ Opcodes.local_get, pointer ],
      ...number(ValtypeSize.i16, Valtype.i32),
      [ Opcodes.i32_add ],
      [ Opcodes.local_set, pointer ],

      // increment counter by 1
      [ Opcodes.local_get, counter ],
      ...number(1, Valtype.i32),
      [ Opcodes.i32_add ],
      [ Opcodes.local_tee, counter ],

      // loop if counter != length
      [ Opcodes.local_get, length ],
      [ Opcodes.i32_ne ],
      [ Opcodes.br_if, 1 ],

      [ Opcodes.end ],
      [ Opcodes.end ]
    ],
    default: internalThrow(scope, 'TypeError', `Tried for..of on non-iterable type`)
  }, Blocktype.void));

  depth.pop();
  depth.pop();
  depth.pop();

  return out;
};

const getNearestLoop = () => {
  for (let i = depth.length - 1; i >= 0; i--) {
    if (depth[i] === 'while' || depth[i] === 'for' || depth[i] === 'forof') return i;
  }

  return -1;
};

const generateBreak = (scope, decl) => {
  const nearestLoop = depth.length - getNearestLoop();
  return [
    [ Opcodes.br, ...signedLEB128(nearestLoop - 2) ]
  ];
};

const generateContinue = (scope, decl) => {
  const nearestLoop = depth.length - getNearestLoop();
  return [
    [ Opcodes.br, ...signedLEB128(nearestLoop - 3) ]
  ];
};

const generateThrow = (scope, decl) => {
  scope.throws = true;

  let message = decl.argument.value, constructor = null;

  // hack: throw new X("...") -> throw "..."
  if (!message && (decl.argument.type === 'NewExpression' || decl.argument.type === 'CallExpression')) {
    constructor = decl.argument.callee.name;
    message = decl.argument.arguments[0].value;
  }

  if (tags.length === 0) tags.push({
    params: [ Valtype.i32 ],
    results: [],
    idx: tags.length
  });

  let exceptId = exceptions.push({ constructor, message }) - 1;
  let tagIdx = tags[0].idx;

  // todo: write a description of how this works lol

  return [
    [ Opcodes.i32_const, signedLEB128(exceptId) ],
    [ Opcodes.throw, tagIdx ]
  ];
};

const generateTry = (scope, decl) => {
  if (decl.finalizer) return todo('try finally not implemented yet');

  const out = [];

  out.push([ Opcodes.try, Blocktype.void ]);
  depth.push('try');

  out.push(...generate(scope, decl.block));

  if (decl.handler) {
    depth.pop();
    depth.push('catch');

    out.push([ Opcodes.catch_all ]);
    out.push(...generate(scope, decl.handler.body));
  }

  out.push([ Opcodes.end ]);
  depth.pop();

  return out;
};

const generateEmpty = (scope, decl) => {
  return [];
};

const generateAssignPat = (scope, decl) => {
  // TODO
  // if identifier declared, use that
  // else, use default (right)
  return todo('assignment pattern (optional arg)');
};

let pages = new Map();
const allocPage = (reason, type) => {
  if (pages.has(reason)) return pages.get(reason).ind;

  if (reason.startsWith('array:')) pages.hasArray = true;
  if (reason.startsWith('string:')) pages.hasString = true;

  const ind = pages.size;
  pages.set(reason, { ind, type });

  if (allocLog) log('alloc', `allocated new page of memory (${ind}) | ${reason} (type: ${type})`);

  return ind;
};

const freePage = reason => {
  const { ind } = pages.get(reason);
  pages.delete(reason);

  if (allocLog) log('alloc', `freed page of memory (${ind}) | ${reason}`);

  return ind;
};

const itemTypeToValtype = {
  i32: 'i32',
  i64: 'i64',
  f64: 'f64',

  i8: 'i32',
  i16: 'i32'
};

const StoreOps = {
  i32: Opcodes.i32_store,
  i64: Opcodes.i64_store,
  f64: Opcodes.f64_store,

  // expects i32 input!
  i16: Opcodes.i32_store16
};

let data = [];

const compileBytes = (val, itemType, signed = true) => {
  // todo: this is a mess and needs confirming / ????
  switch (itemType) {
    case 'i8': return [ val % 256 ];
    case 'i16': return [ val % 256, Math.floor(val / 256) ];

    case 'i32':
    case 'i64':
      return enforceFourBytes(signedLEB128(val));

    case 'f64': return ieee754_binary64(val);
  }
};

const makeArray = (scope, decl, global = false, name = '$undeclared', initEmpty = false, itemType = valtype) => {
  const out = [];

  let firstAssign = false;
  if (!arrays.has(name) || name === '$undeclared') {
    firstAssign = true;

    // todo: can we just have 1 undeclared array? probably not? but this is not really memory efficient
    const uniqueName = name === '$undeclared' ? name + Math.random().toString().slice(2) : name;
    arrays.set(name, allocPage(`${itemType === 'i16' ? 'string' : 'array'}: ${uniqueName}`, itemType) * pageSize);
  }

  const pointer = arrays.get(name);

  const useRawElements = !!decl.rawElements;
  const elements = useRawElements ? decl.rawElements : decl.elements;

  const valtype = itemTypeToValtype[itemType];
  const length = elements.length;

  if (firstAssign && useRawElements) {
    let bytes = compileBytes(length, 'i32');

    if (!initEmpty) for (let i = 0; i < length; i++) {
      if (elements[i] == null) continue;

      bytes.push(...compileBytes(elements[i], itemType));
    }

    data.push({
      offset: pointer,
      bytes
    });

    // local value as pointer
    out.push(...number(pointer));

    return [ out, pointer ];
  }

  // store length as 0th array
  out.push(
    ...number(0, Valtype.i32),
    ...number(length, Valtype.i32),
    [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ]
  );

  const storeOp = StoreOps[itemType];

  if (!initEmpty) for (let i = 0; i < length; i++) {
    if (elements[i] == null) continue;

    out.push(
      ...number(0, Valtype.i32),
      ...(useRawElements ? number(elements[i], Valtype[valtype]) : generate(scope, elements[i])),
      [ storeOp, Math.log2(ValtypeSize[itemType]) - 1, ...unsignedLEB128(pointer + ValtypeSize.i32 + i * ValtypeSize[itemType]) ]
    );
  }

  // local value as pointer
  out.push(...number(pointer));

  return [ out, pointer ];
};

const makeString = (scope, str, global = false, name = '$undeclared') => {
  const rawElements = new Array(str.length);
  for (let i = 0; i < str.length; i++) {
    rawElements[i] = str.charCodeAt(i);
  }

  return makeArray(scope, {
    rawElements
  }, global, name, false, 'i16')[0];
};

let arrays = new Map();
const generateArray = (scope, decl, global = false, name = '$undeclared', initEmpty = false) => {
  return makeArray(scope, decl, global, name, initEmpty, valtype)[0];
};

export const generateMember = (scope, decl, _global, _name) => {
  const name = decl.object.name;
  const pointer = arrays.get(name);

  const aotPointer = pointer != null;

  // hack: .length
  if (decl.property.name === 'length') {
    // if (![TYPES._array, TYPES.string].includes(type)) return number(UNDEFINED);
    return [
      ...(aotPointer ? number(0, Valtype.i32) : [
        ...generate(scope, decl.object),
        Opcodes.i32_to_u
      ]),

      [ Opcodes.i32_load, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128((aotPointer ? pointer : 0)) ],
      Opcodes.i32_from_u
    ];
  }

  // // todo: we should only do this for strings but we don't know at compile-time :(
  // hack: this is naughty and will break things!
  let newOut = number(0, valtypeBinary), newPointer = -1;
  if (pages.hasString) {
    0, [ newOut, newPointer ] = makeArray(scope, {
      rawElements: new Array(1)
    }, _global, _name, true, 'i16');
  }

  return typeSwitch(scope, getNodeType(scope, decl.object), {
    [TYPES._array]: [
      // get index as valtype
      ...generate(scope, decl.property),

      // convert to i32 and turn into byte offset by * valtypeSize (4 for i32, 8 for i64/f64)
      Opcodes.i32_to_u,
      ...number(ValtypeSize[valtype], Valtype.i32),
      [ Opcodes.i32_mul ],

      ...(aotPointer ? [] : [
        ...generate(scope, decl.object),
        Opcodes.i32_to_u,
        [ Opcodes.i32_add ]
      ]),

      // read from memory
      [ Opcodes.load, Math.log2(ValtypeSize[valtype]) - 1, ...unsignedLEB128((aotPointer ? pointer : 0) + ValtypeSize.i32) ],

      ...number(TYPES.number, Valtype.i32),
      setLastType(scope)
    ],

    [TYPES.string]: [
      // setup new/out array
      ...newOut,
      [ Opcodes.drop ],

      ...number(0, Valtype.i32), // base 0 for store later

      ...generate(scope, decl.property),

      Opcodes.i32_to_u,
      ...number(ValtypeSize.i16, Valtype.i32),
      [ Opcodes.i32_mul ],

      ...(aotPointer ? [] : [
        ...generate(scope, decl.object),
        Opcodes.i32_to_u,
        [ Opcodes.i32_add ]
      ]),

      // load current string ind {arg}
      [ Opcodes.i32_load16_u, Math.log2(ValtypeSize.i16) - 1, ...unsignedLEB128((aotPointer ? pointer : 0) + ValtypeSize.i32) ],

      // store to new string ind 0
      [ Opcodes.i32_store16, Math.log2(ValtypeSize.i16) - 1, ...unsignedLEB128(newPointer + ValtypeSize.i32) ],

      // return new string (page)
      ...number(newPointer),

      ...number(TYPES.string, Valtype.i32),
      setLastType(scope)
    ],

    default: [ [ Opcodes.unreachable ] ]
  });
};

const randId = () => Math.random().toString(16).slice(0, -4);

const objectHack = node => {
  if (!node) return node;

  if (node.type === 'MemberExpression') {
    if (node.computed || node.optional) return node;

    let objectName = node.object.name;

    // if object is not identifier or another member exp, give up
    if (node.object.type !== 'Identifier' && node.object.type !== 'MemberExpression') return node;

    if (!objectName) objectName = objectHack(node.object).name.slice(2);

    // if .length, give up (hack within a hack!)
    if (node.property.name === 'length') return node;

    const name = '__' + objectName + '_' + node.property.name;
    if (codeLog) log('codegen', `object hack! ${node.object.name}.${node.property.name} -> ${name}`);

    return {
      type: 'Identifier',
      name
    };
  }

  for (const x in node) {
    if (node[x] != null && typeof node[x] === 'object') {
      if (node[x].type) node[x] = objectHack(node[x]);
      if (Array.isArray(node[x])) node[x] = node[x].map(y => objectHack(y));
    }
  }

  return node;
};

const generateFunc = (scope, decl) => {
  if (decl.async) return todo('async functions are not supported');
  if (decl.generator) return todo('generator functions are not supported');

  const name = decl.id ? decl.id.name : `anonymous_${randId()}`;
  const params = decl.params ?? [];

  // const innerScope = { ...scope };
  // TODO: share scope/locals between !!!
  const innerScope = {
    locals: {},
    localInd: 0,
    // value, type
    returns: [ valtypeBinary, Valtype.i32 ],
    throws: false,
    name
  };

  for (let i = 0; i < params.length; i++) {
    allocVar(innerScope, params[i].name, false);

    if (typedInput && params[i].typeAnnotation) {
      addVarMetadata(innerScope, params[i].name, false, extractTypeAnnotation(params[i]));
    }
  }

  let body = objectHack(decl.body);
  if (decl.type === 'ArrowFunctionExpression' && decl.expression) {
    // hack: () => 0 -> () => return 0
    body = {
      type: 'ReturnStatement',
      argument: decl.body
    };
  }

  const wasm = generate(innerScope, body);
  const func = {
    name,
    params: Object.values(innerScope.locals).slice(0, params.length * 2).map(x => x.type),
    returns: innerScope.returns,
    locals: innerScope.locals,
    throws: innerScope.throws,
    index: currentFuncIndex++
  };
  funcIndex[name] = func.index;

  // quick hack fixes
  for (const inst of wasm) {
    if (inst[0] === Opcodes.call && inst[1] === -1) {
      inst[1] = func.index;
    }
  }

  // add end return if not found
  if (name !== 'main' && wasm[wasm.length - 1]?.[0] !== Opcodes.return && countLeftover(wasm) === 0) {
    wasm.push(
      ...number(0),
      ...number(TYPES.undefined, Valtype.i32),
      [ Opcodes.return ]
    );
  }

  func.wasm = wasm;

  funcs.push(func);

  return func;
};

const generateCode = (scope, decl) => {
  let out = [];

  for (const x of decl.body) {
    out = out.concat(generate(scope, x));
  }

  return out;
};

const internalConstrs = {
  Array: {
    generate: (scope, decl, global, name) => {
      // new Array(i0, i1, ...)
      if (decl.arguments.length > 1) return generateArray(scope, {
        elements: decl.arguments
      }, global, name);

      // new Array(n)

      const [ , pointer ] = makeArray(scope, {
        rawElements: new Array(0)
      }, global, name, true);

      const arg = decl.arguments[0] ?? DEFAULT_VALUE;

      // todo: check in wasm instead of here
      const literalValue = arg.value ?? 0;
      if (literalValue < 0 || !Number.isFinite(literalValue) || literalValue > 4294967295) return internalThrow(scope, 'RangeThrow', 'Invalid array length');

      return [
        ...number(0, Valtype.i32),
        ...generate(scope, arg, global, name),
        Opcodes.i32_to_u,
        [ Opcodes.i32_store, Math.log2(ValtypeSize.i32) - 1, ...unsignedLEB128(pointer) ],

        ...number(pointer)
      ];
    },
    type: TYPES._array
  },

  __Array_of: {
    // this is not a constructor but best fits internal structure here
    generate: (scope, decl, global, name) => {
      // Array.of(i0, i1, ...)
      return generateArray(scope, {
        elements: decl.arguments
      }, global, name);
    },
    type: TYPES._array,
    notConstr: true
  }
};

// const _ = Array.prototype.push;
// Array.prototype.push = function (a) {
//   const check = arr => {
//     for (const x of arr) {
//       if (x === undefined) {
//         console.trace(arr);
//         process.exit();
//       }
//       if (Array.isArray(x)) check(x);
//     }
//   };
//   if (Array.isArray(a) && !new Error().stack.includes('node:')) check(a);
//   // if (Array.isArray(a)) check(a);

//   return _.apply(this, arguments);
// };

export default program => {
  globals = {};
  globalInd = 0;
  tags = [];
  exceptions = [];
  funcs = [];
  funcIndex = {};
  depth = [];
  arrays = new Map();
  pages = new Map();
  data = [];
  currentFuncIndex = importedFuncs.length;

  globalThis.valtype = 'f64';

  const valtypeOpt = process.argv.find(x => x.startsWith('-valtype='));
  if (valtypeOpt) valtype = valtypeOpt.split('=')[1];

  globalThis.valtypeBinary = Valtype[valtype];

  const valtypeInd = ['i32', 'i64', 'f64'].indexOf(valtype);

  // set generic opcodes for current valtype
  Opcodes.const = [ Opcodes.i32_const, Opcodes.i64_const, Opcodes.f64_const ][valtypeInd];
  Opcodes.eq = [ Opcodes.i32_eq, Opcodes.i64_eq, Opcodes.f64_eq ][valtypeInd];
  Opcodes.eqz = [ [ [ Opcodes.i32_eqz ] ], [ [ Opcodes.i64_eqz ] ], [ ...number(0), [ Opcodes.f64_eq ] ] ][valtypeInd];
  Opcodes.mul = [ Opcodes.i32_mul, Opcodes.i64_mul, Opcodes.f64_mul ][valtypeInd];
  Opcodes.add = [ Opcodes.i32_add, Opcodes.i64_add, Opcodes.f64_add ][valtypeInd];
  Opcodes.sub = [ Opcodes.i32_sub, Opcodes.i64_sub, Opcodes.f64_sub ][valtypeInd];

  Opcodes.i32_to = [ [ null ], [ Opcodes.i32_wrap_i64 ], Opcodes.i32_trunc_sat_f64_s ][valtypeInd];
  Opcodes.i32_to_u = [ [ null ], [ Opcodes.i32_wrap_i64 ], Opcodes.i32_trunc_sat_f64_u ][valtypeInd];
  Opcodes.i32_from = [ [ null ], [ Opcodes.i64_extend_i32_s ], [ Opcodes.f64_convert_i32_s ] ][valtypeInd];
  Opcodes.i32_from_u = [ [ null ], [ Opcodes.i64_extend_i32_u ], [ Opcodes.f64_convert_i32_u ] ][valtypeInd];

  Opcodes.load = [ Opcodes.i32_load, Opcodes.i64_load, Opcodes.f64_load ][valtypeInd];
  Opcodes.store = [ Opcodes.i32_store, Opcodes.i64_store, Opcodes.f64_store ][valtypeInd];

  Opcodes.lt = [ Opcodes.i32_lt_s, Opcodes.i64_lt_s, Opcodes.f64_lt ][valtypeInd];

  builtinFuncs = new BuiltinFuncs();
  builtinVars = new BuiltinVars();
  prototypeFuncs = new PrototypeFuncs();

  program.id = { name: 'main' };

  globalThis.pageSize = PageSize;
  const pageSizeOpt = process.argv.find(x => x.startsWith('-page-size='));
  if (pageSizeOpt) pageSize = parseInt(pageSizeOpt.split('=')[1]) * 1024;

  const scope = {
    locals: {},
    localInd: 0
  };

  program.body = {
    type: 'BlockStatement',
    body: program.body
  };

  if (process.argv.includes('-ast-log')) console.log(program.body.body);

  generateFunc(scope, program);

  const main = funcs[funcs.length - 1];
  main.export = true;
  main.returns = [ valtypeBinary, Valtype.i32 ];

  const lastInst = main.wasm[main.wasm.length - 1] ?? [ Opcodes.end ];
  if (lastInst[0] === Opcodes.drop) {
    main.wasm.splice(main.wasm.length - 1, 1);

    const finalStatement = program.body.body[program.body.body.length - 1];
    main.wasm.push(...getNodeType(main, finalStatement));
  }

  if (lastInst[0] === Opcodes.end || lastInst[0] === Opcodes.local_set || lastInst[0] === Opcodes.global_set) {
    main.returns = [];
  }

  if (lastInst[0] === Opcodes.call) {
    const func = funcs.find(x => x.index === lastInst[1]);
    if (func) main.returns = func.returns.slice();
      else main.returns = [];
  }

  // if blank main func and other exports, remove it
  if (main.wasm.length === 0 && funcs.reduce((acc, x) => acc + (x.export ? 1 : 0), 0) > 1) funcs.splice(funcs.length - 1, 1);

  return { funcs, globals, tags, exceptions, pages, data };
};