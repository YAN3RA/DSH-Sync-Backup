/**
 * dsh-sync-backup / tools/_stubs/schemastery.js
 *
 * 最小 schemastery 替身，仅供本地 smoke 测试使用。
 * 真实实现在 DSH Host loader 下由 profile 提供；本文件**不参与插件运行**。
 *
 * 只需覆盖 index.js 用到的调用形态：z.object({...}).default(...) 以及
 * z.number() / z.boolean() / z.string() / z.array(...) 的链式 .default()。
 */

function makeSchema(kind) {
  const schema = {
    kind,
    optional() {
      return schema;
    },
    default(v) {
      schema.defaultValue = v;
      return schema;
    },
    description() {
      return schema;
    },
  };
  return schema;
}

const z = {
  number: () => makeSchema("number"),
  boolean: () => makeSchema("boolean"),
  string: () => makeSchema("string"),
  array: (inner) => {
    const s = makeSchema("array");
    s.inner = inner;
    return s;
  },
  object(shape) {
    const schema = {
      kind: "object",
      shape,
      default(v) {
        schema.defaultValue = v;
        return schema;
      },
      optional() {
        return schema;
      },
      description() {
        return schema;
      },
      /** 测试用：按 shape 的 default 值填充缺省。 */
      resolve(input = {}) {
        const out = { ...input };
        for (const [k, s] of Object.entries(shape ?? {})) {
          if (out[k] === undefined && s && s.defaultValue !== undefined) out[k] = s.defaultValue;
        }
        return out;
      },
    };
    return schema;
  },
};

export default z;
export { z };
