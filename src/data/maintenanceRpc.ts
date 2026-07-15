import type { DataImportRpcRequest, DataImportRpcResult } from './maintenanceRpcProtocol';

export * from './maintenanceRpcProtocol';

export async function sendDataImportRpc<T extends DataImportRpcResult>(
  request: DataImportRpcRequest,
): Promise<T> {
  const response: unknown = await chrome.runtime.sendMessage(request);
  if (!isRecord(response) || typeof response.ok !== 'boolean') {
    throw new Error('数据维护后台返回了无效响应');
  }
  if (!response.ok) {
    throw new Error(typeof response.error === 'string' ? response.error : '数据维护请求失败');
  }
  if (!('result' in response)) throw new Error('数据维护后台响应缺少结果');
  return response.result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
