/**
 * dsh-sync-backup / tools/_stubs/dsh-tools.js
 *
 * 最小 defineTool 替身，仅供本地 smoke 测试使用。
 * 真实实现在 DSH Host loader 下由 profile 提供。
 *
 * ⚠️ 本替身必须**忠实复刻真实实现会拒绝的 schema 形态** —— 2026-10-09 的
 * link 加载失败正是因为它太宽松：`channels: { type: "object" }` 缺
 * `additionalProperties`，六套本地测试全绿，而真实 `defineTool` 在
 * `runSchemaCompiler` 里直接抛 `JsonSchemaError`，插件 entry 当场 inactive。
 * 教训：替身只要放松一条作者侧校验规则，就会把该规则的回归漏到生产。
 *
 * 复刻自 asar 内 `@deepseek-ai/dsh-tools/lib/index.js`：
 *   - runSchemaCompiler (:586)  —— 迭代式编译 + 作者规则
 *   - checkSchemaNode   (:163)  —— 编译产物二次校验（assertSupportedJsonSchema）
 * 规则逐条对应真实行号，见各 case 内注释。
 */

const ANNOTATION_KEYS = ["description", "title", "default", "examples"];
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const ALL_TYPES = new Set([...SCALAR_TYPES, "array", "object", "json"]);

function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 真实 :556 assertAuthorKeys —— 超出该节点词汇表的键一律拒绝。 */
function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      throw new Error(`unsupported JSON schema: ${path}.${key} is not supported by the value schema DSL`);
    }
  }
}

/**
 * 真实 :586 runSchemaCompiler 的递归等价实现（本地测试不需要迭代式）：
 * 编译并同时执行全部作者侧规则。返回规范化后的 schema。
 */
function compileValueSchema(input, path) {
  if (!isRecord(input)) throw new Error(`unsupported JSON schema: ${path} must be a value schema object`);

  if (Object.hasOwn(input, "oneOf")) {
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, "oneOf", "type"]);
    if (Object.hasOwn(input, "type")) {
      throw new Error(`unsupported JSON schema: ${path} cannot declare both type and oneOf`);
    }
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      throw new Error(`unsupported JSON schema: ${path}.oneOf must be an array of at least two value schemas`);
    }
    return { ...pickAnnotations(input), oneOf: input.oneOf.map((s, i) => compileValueSchema(s, `${path}.oneOf[${i}]`)) };
  }

  const type = Object.hasOwn(input, "type") ? input.type : undefined;
  if (typeof type !== "string" || !ALL_TYPES.has(type)) {
    // 真实 :751 —— type 数组不支持，且必须是允许的单一字符串
    throw new Error(
      `unsupported JSON schema: ${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`,
    );
  }

  switch (type) {
    case "json":
      assertAuthorKeys(input, path, [...ANNOTATION_KEYS, "type"]);
      return { ...pickAnnotations(input), type: "json" };

    case "object": {
      assertAuthorKeys(input, path, [...ANNOTATION_KEYS, "type", "properties", "additionalProperties"]);
      // 真实 :699 —— 这是导致 link 加载失败的那条规则
      if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") {
        throw new Error(
          `unsupported JSON schema: ${path}.additionalProperties must be explicitly true or false`,
        );
      }
      const node = { ...pickAnnotations(input), type: "object", additionalProperties: input.additionalProperties };
      if (Object.hasOwn(input, "properties")) {
        if (!isRecord(input.properties)) throw new Error(`unsupported JSON schema: ${path}.properties must be an object of value schemas`);
        // 真实 :703-711 + :581-584 assignCompiledPropertyMap —— 只把内层 properties
        // 装到节点上，**不是**整个 holder（否则会多出一层 `.properties.properties`）。
        const compiled = compilePropertyMap(input.properties, `${path}.properties`);
        node.properties = compiled.properties;
        if (compiled.required !== undefined) node.required = compiled.required;
      }
      return node;
    }

    case "array": {
      assertAuthorKeys(input, path, [...ANNOTATION_KEYS, "type", "items"]);
      const node = { ...pickAnnotations(input), type: "array" };
      if (Object.hasOwn(input, "items")) node.items = compileValueSchema(input.items, `${path}.items`);
      return node;
    }

    default: {
      assertAuthorKeys(input, path, [...ANNOTATION_KEYS, "type", "enum", "const"]);
      const node = { ...pickAnnotations(input), type };
      if (Object.hasOwn(input, "enum")) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) {
          throw new Error(`unsupported JSON schema: ${path}.enum must be a non-empty array of scalar values`);
        }
        node.enum = [...input.enum];
      }
      if (Object.hasOwn(input, "const")) node.const = input.const;
      return node;
    }
  }
}

/** 真实 :756 compilePropertyMap —— 逐属性编译，`required: true` 收集成列表。 */
function compilePropertyMap(input, path) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(input)) {
    if (!isRecord(spec)) throw new Error(`unsupported JSON schema: ${path}.${key} must be a value schema object`);
    // 真实 :603 —— required 只能是 true，不能是 false
    if (Object.hasOwn(spec, "required") && spec.required !== true) {
      throw new Error(`unsupported JSON schema: ${path}.${key}.required must be true when present`);
    }
    if (spec.required === true) required.push(key);
    const { required: _drop, ...rest } = spec;
    properties[key] = compileValueSchema(rest, `${path}.${key}`);
  }
  const holder = { properties };
  if (required.length > 0) holder.required = required;
  return holder;
}

function pickAnnotations(source) {
  const out = {};
  for (const key of ANNOTATION_KEYS) if (Object.hasOwn(source, key)) out[key] = source[key];
  return out;
}

/**
 * 真实 :163 checkSchemaNode + :152 checkObjectSchemaTail 的等价复核
 * （对**编译产物**跑一遍子集校验）。
 *
 * ⚠️ 关键差异，别搞混：
 *   - 作者 DSL（compileValueSchema，真实 :699）要求 `type:"object"` **必须**显式写
 *     `additionalProperties: true|false`；
 *   - 编译产物（本函数，真实 :160）只在 `additionalProperties` **存在时**要求它是
 *     布尔值，缺失合法 —— 真实 `parameterSchemaSpecToJsonSchema`(:802) 造出来的
 *     根节点就**不带** `additionalProperties`。
 * 我的第一版把作者规则套到编译产物上，反而把六套测试全打红了。
 */
const CONSTRAINT_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);
const ONE_OF_SIBLING_KEYWORDS = ["properties", "required", "additionalProperties", "items", "enum", "const"];
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const KEYWORD_TYPES = {
  properties: ["object"],
  required: ["object"],
  additionalProperties: ["object"],
  items: ["array"],
  enum: ["string", "number", "integer", "boolean", "null"],
  const: ["string", "number", "integer", "boolean", "null"],
};

function scalarMatches(type, value) {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

function assertSupportedJsonSchema(schema) {
  const violations = [];
  const check = (node, at) => {
    if (!isRecord(node)) {
      violations.push(`${at} must be a schema object`);
      return;
    }
    // 真实 :196-207 —— 词汇表之外的键一律拒绝
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue;
      if (ANNOTATION_KEYWORDS.has(key)) continue;
      violations.push(
        `${at}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
      );
    }
    if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${at}.description must be a string`);
    if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${at}.title must be a string`);

    const hasType = Object.hasOwn(node, "type");
    const hasOneOf = Object.hasOwn(node, "oneOf");
    if (hasType && hasOneOf) {
      violations.push(`${at} cannot declare both type and oneOf`);
      return;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${at}.${key} requires type or oneOf`);
      }
      return;
    }
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${at}.${key} is not supported beside oneOf`);
      }
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${at}.oneOf must be an array of at least two schemas`);
      else node.oneOf.forEach((s, i) => check(s, `${at}.oneOf[${i}]`));
      return;
    }

    const type = node.type;
    if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
      violations.push(
        Array.isArray(type)
          ? `${at}.type must be a single type string (type arrays are not supported)`
          : `${at}.type must be one of ${SCHEMA_TYPES.join("/")}`,
      );
      return;
    }
    for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
      if (Object.hasOwn(node, key) && !types.includes(type)) violations.push(`${at}.${key} is not supported on type "${type}"`);
    }

    switch (type) {
      case "object": {
        const properties = Object.hasOwn(node, "properties") ? node.properties : undefined;
        if (Object.hasOwn(node, "properties")) {
          if (!isRecord(properties)) violations.push(`${at}.properties must be an object of schemas`);
          else for (const [k, s] of Object.entries(properties)) check(s, `${at}.properties.${k}`);
        }
        // 真实 :153-159 checkObjectSchemaTail
        if (Object.hasOwn(node, "required")) {
          const required = node.required;
          if (!Array.isArray(required) || required.some((e) => typeof e !== "string")) {
            violations.push(`${at}.required must be an array of strings`);
          } else {
            const declared = isRecord(properties) ? properties : {};
            for (const key of required) {
              if (!Object.hasOwn(declared, key)) violations.push(`${at}.required names "${key}" which is not in properties`);
            }
          }
        }
        // 真实 :160 —— **存在时**才要求布尔；缺失合法（真实现的参数根节点就不带它）
        if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") {
          violations.push(`${at}.additionalProperties must be a boolean`);
        }
        break;
      }
      case "array":
        if (Object.hasOwn(node, "items")) check(node.items, `${at}.items`);
        break;
      default: {
        const hasEnum = Object.hasOwn(node, "enum");
        const allowed = hasEnum ? node.enum : undefined;
        const enumValid = Array.isArray(allowed) && allowed.length > 0 && allowed.every((e) => scalarMatches(type, e));
        if (hasEnum && !enumValid) violations.push(`${at}.enum must be a non-empty array of ${type} values`);
        if (Object.hasOwn(node, "const")) {
          if (!scalarMatches(type, node.const)) violations.push(`${at}.const must be a ${type} value`);
          else if (enumValid && !allowed.includes(node.const)) violations.push(`${at}.const must be one of ${at}.enum when both are declared`);
        }
        break;
      }
    }
  };
  check(schema, "schema");
  if (violations.length > 0) throw new Error(`unsupported JSON schema: ${violations.join("; ")}`);
}

/** 真实 :802 parameterSchemaSpecToJsonSchema */
export function parameterSchemaSpecToJsonSchema(spec) {
  const compiled = compilePropertyMap(spec, "parameters");
  const schema = { type: "object", ...compiled };
  assertSupportedJsonSchema(schema);
  return schema;
}

/** 真实 :792 valueSchemaSpecToJsonSchema */
export function valueSchemaSpecToJsonSchema(spec) {
  const schema = compileValueSchema(spec, "schema");
  assertSupportedJsonSchema(schema);
  return schema;
}

/**
 * 真实 :838 defineTool —— 与真实现同样在校验期拒绝非法 schema，
 * 并同样要求 output.render 是函数。
 */
export function defineTool(def) {
  if (!def || typeof def !== "object") throw new Error("defineTool: 需要定义对象");
  if (!def.name || typeof def.name !== "string") throw new Error("defineTool: name 必填");
  if (typeof def.execute !== "function") throw new Error(`defineTool: ${def.name} 缺少 execute`);
  if (def.timeoutMs !== undefined && !(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0)) {
    throw new Error(`defineTool: ${def.name} timeoutMs 必须是正的有限数`);
  }
  if (def.name === "run_code") throw new Error(`tool name "run_code" is reserved`);

  const parameters = parameterSchemaSpecToJsonSchema(def.parameters ?? {});
  const output = def.output;
  // 真实 :2881
  if (
    output === undefined ||
    typeof output !== "object" ||
    typeof output.render !== "function" ||
    (output.presentationMeta !== undefined && typeof output.presentationMeta !== "function")
  ) {
    throw new TypeError(`tool "${def.name}" must declare output { schema, render, presentationMeta? }`);
  }
  const outputSchema = valueSchemaSpecToJsonSchema(output.schema);
  return { ...def, parameters, output: { ...output, schema: outputSchema } };
}

export const __test__ = { compileValueSchema, compilePropertyMap, assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema };
export default { defineTool, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema };
