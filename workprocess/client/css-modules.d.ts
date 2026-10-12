/** CSS Modules 的类型面（构建期由 lightningcss 生成类名映射；类型上就是一张只读表）。 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
