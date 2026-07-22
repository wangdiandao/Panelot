import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const disclosure = readFileSync(
  fileURLToPath(new URL('../../store/data-disclosure.md', import.meta.url)),
  'utf8',
);

describe('store data disclosure contract', () => {
  it('states the implemented read and write approval boundaries in both languages', () => {
    for (const token of ['`always`', '`untrusted`', '`auto`']) {
      expect(disclosure).toContain(token);
    }
    expect(disclosure).toContain(
      '**Ask for everything** (`always`) asks before reads; **Ask before acting** (`untrusted`) and **Act automatically** (`auto`) allow reads without a separate prompt.',
    );
    expect(disclosure).toContain(
      '**Act automatically** can run them without a per-call prompt unless a rule or safety check forces ASK or DENY.',
    );
    expect(disclosure).toContain('Saved rules apply in all three modes.');
    expect(disclosure).toContain(
      '“全程询问”（`always`）会在读取前询问；“操作询问”（`untrusted`）和“自动操作”（`auto`）下，读取不会另行弹出审批。',
    );
  });

  it('treats MCP annotations as metadata and distinguishes file metadata from uploads', () => {
    expect(disclosure).toContain(
      'Server-supplied annotations such as `readOnlyHint` are treated only as untrusted descriptive metadata and do not by themselves bypass approval.',
    );
    expect(disclosure).toContain(
      'the selected model receives its name, MIME type, size, and attachment identifier so it can reference the file through browser tools; the file bytes are not sent as a normal model attachment.',
    );
    expect(disclosure).toContain(
      'Uploading those bytes to a website is a browser write and follows the active approval policy and rules.',
    );
    expect(disclosure).toContain(
      '所选模型只会收到文件名、MIME 类型、大小和附件标识，以便通过浏览器工具引用该文件；文件字节不会作为普通模型附件发送。',
    );
  });

  it('states the direct-request and no-redirect credential boundary in both languages', () => {
    expect(disclosure).toContain(
      'Credential-bearing Provider and MCP requests are sent directly to request URLs derived from the validated configuration; automatic HTTP redirects are refused.',
    );
    expect(disclosure).toContain(
      'OAuth authorization, code exchange, and refresh requests bind the canonical MCP server resource identifier.',
    );
    expect(disclosure).toContain(
      '携带凭据的 Provider 和 MCP 请求会直接发送到根据已校验配置生成的请求 URL；自动 HTTP 重定向会被拒绝。',
    );
    expect(disclosure).toContain(
      'OAuth 授权、code 交换和 refresh 请求会绑定规范化的 MCP 服务器资源标识符。',
    );
  });
});
