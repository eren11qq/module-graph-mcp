/**
 * getFreePort 的实现在 src/evals/mcp-client.ts(tsconfig rootDir 决定了它住在
 * src 侧;evals 探针与全部测试共用那一份)——这里只做再导出,调用方 import
 * 路径不变,逐字副本消除。
 */
export { getFreePort } from '../../src/evals/mcp-client.js';
