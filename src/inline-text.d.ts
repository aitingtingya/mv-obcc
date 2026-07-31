// esbuild 的 inline: 前缀导入（见 esbuild.config.mjs 的 inlineImportPlugin）
// 把目标文件以 UTF-8 文本形式内嵌为字符串常量。
declare module "inline:*" {
  const contents: string;
  export default contents;
}
