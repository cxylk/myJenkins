import type { SecretBox } from './lib/crypto.js';

let box: SecretBox | null = null;

export function setSecretBox(value: SecretBox): void {
  box = value;
}

export function secrets(): SecretBox {
  if (!box) throw new Error('密钥模块尚未初始化');
  return box;
}
