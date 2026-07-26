#!/usr/bin/env node
// 飞书文档/多维表格工具（MCP stdio 服务）
//
// 只用机器人应用**自己的租户凭据**，能碰什么完全由飞书后台开的 scope 决定；
// 机器人拿不到 shell，也无法越过这里暴露的几个动作。
// 需要的权限（开发者后台「权限管理」→ 批量导入后发布版本）：
//   docx:document:readonly / docx:document        （读/写云文档）
//   bitable:app:readonly    / bitable:app         （读/写多维表格）
//   wiki:wiki:readonly                            （知识库节点解析）
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const DOMAIN = process.env.FEISHU_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

if (!APP_ID || !APP_SECRET) {
  console.error('mcp-feishu: 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: DOMAIN,
  loggerLevel: lark.LoggerLevel.error, // stdio 是 MCP 通道，日志必须走 stderr
});

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2).slice(0, 60000) }] });
const fail = (e) => ({
  content: [{ type: 'text', text: `失败：${e?.message ?? e}\n（若提示权限不足，请在开发者后台开通对应 scope 并发布新版本）` }],
  isError: true,
});

// 从飞书 URL 或裸 token 中提取 { type, token, tableId }
function parseTarget(input) {
  const s = String(input).trim();
  const table = s.match(/[?&]table=([A-Za-z0-9]+)/)?.[1] ?? null;
  const m = s.match(/\/(docx|base|wiki|sheets)\/([A-Za-z0-9]+)/);
  if (m) return { type: m[1], token: m[2], tableId: table };
  return { type: 'unknown', token: s.replace(/[?#].*$/, ''), tableId: table };
}

// 知识库节点 → 实际文档/表格 token
async function resolveWiki(token) {
  const res = await client.wiki.v2.space.getNode({ params: { token } });
  const node = res?.data?.node ?? res?.node;
  if (!node?.obj_token) throw new Error('无法解析该 wiki 节点');
  return { objToken: node.obj_token, objType: node.obj_type };
}

const server = new McpServer({ name: 'feishu', version: '1.0.0' });

// ---------- 云文档 ----------
server.tool(
  'doc_read',
  '读取飞书云文档的纯文本内容。传文档 URL（/docx/ 或 /wiki/）或 document_id。',
  { url: z.string().describe('文档 URL 或 document_id') },
  async ({ url }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      const res = await client.docx.v1.document.rawContent({
        path: { document_id: token },
        params: { lang: 0 },
      });
      return ok({ document_id: token, content: res?.data?.content ?? res?.content ?? '' });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'doc_append',
  '在飞书云文档末尾追加文本段落（每行一个段落块）。需要 docx:document 写权限，且该文档已授权给本应用。',
  {
    url: z.string().describe('文档 URL 或 document_id'),
    text: z.string().describe('要追加的文本，按换行拆分为多个段落'),
  },
  async ({ url, text }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      const children = String(text)
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => ({
          block_type: 2, // 正文段落
          text: { elements: [{ text_run: { content: line } }], style: {} },
        }));
      if (!children.length) throw new Error('内容为空');
      const res = await client.docx.v1.documentBlockChildren.create({
        path: { document_id: token, block_id: token }, // 根块 id 与文档 id 相同
        data: { children, index: -1 },
      });
      return ok({ appended: children.length, revision: res?.data?.document_revision_id });
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 多维表格 ----------
server.tool(
  'bitable_tables',
  '列出多维表格里的数据表（拿 table_id 用）。传多维表格 URL（/base/ 或 /wiki/）或 app_token。',
  { url: z.string().describe('多维表格 URL 或 app_token') },
  async ({ url }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      const res = await client.bitable.v1.appTable.list({
        path: { app_token: token },
        params: { page_size: 100 },
      });
      const items = (res?.data?.items ?? res?.items ?? []).map((t) => ({ table_id: t.table_id, name: t.name }));
      return ok({ app_token: token, tables: items });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'bitable_fields',
  '列出某张数据表的字段（字段名与类型，写入前先看这个）。',
  { url: z.string(), table_id: z.string() },
  async ({ url, table_id }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      const res = await client.bitable.v1.appTableField.list({
        path: { app_token: token, table_id },
        params: { page_size: 200 },
      });
      const items = (res?.data?.items ?? res?.items ?? []).map((f) => ({
        field_name: f.field_name,
        type: f.ui_type ?? f.type,
      }));
      return ok({ fields: items });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'bitable_records',
  '读取数据表记录。可用 page_size 控制条数（默认 50，最大 500）。',
  {
    url: z.string(),
    table_id: z.string(),
    page_size: z.number().optional(),
    page_token: z.string().optional(),
  },
  async ({ url, table_id, page_size, page_token }) => {
    try {
      let { type, token, tableId } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      const res = await client.bitable.v1.appTableRecord.list({
        path: { app_token: token, table_id: table_id ?? tableId },
        params: { page_size: Math.min(page_size ?? 50, 500), page_token },
      });
      const d = res?.data ?? res;
      return ok({
        total: d?.total,
        has_more: d?.has_more,
        page_token: d?.page_token,
        records: (d?.items ?? []).map((r) => ({ record_id: r.record_id, fields: r.fields })),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'bitable_create_record',
  '在数据表里新增一条记录。fields 为「字段名 → 值」的对象，字段名需与 bitable_fields 一致。',
  { url: z.string(), table_id: z.string(), fields: z.record(z.any()) },
  async ({ url, table_id, fields }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      const res = await client.bitable.v1.appTableRecord.create({
        path: { app_token: token, table_id },
        data: { fields },
      });
      return ok({ record_id: res?.data?.record?.record_id ?? res?.record?.record_id });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'bitable_update_record',
  '更新数据表里的一条记录（只需传要改的字段）。',
  { url: z.string(), table_id: z.string(), record_id: z.string(), fields: z.record(z.any()) },
  async ({ url, table_id, record_id, fields }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      await client.bitable.v1.appTableRecord.update({
        path: { app_token: token, table_id, record_id },
        data: { fields },
      });
      return ok({ updated: record_id });
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 电子表格 ----------
server.tool(
  'sheet_read',
  '读取飞书电子表格的单元格区域。range 形如 "工作表ID!A1:D20"；不传 range 时读取首个工作表前 100 行。',
  { url: z.string().describe('电子表格 URL 或 spreadsheet_token'), range: z.string().optional() },
  async ({ url, range }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      let target = range;
      if (!target) {
        const meta = await client.sheets.v3.spreadsheetSheet.query({ path: { spreadsheet_token: token } });
        const first = (meta?.data?.sheets ?? meta?.sheets ?? [])[0];
        if (!first) throw new Error('该表格没有工作表');
        target = `${first.sheet_id}!A1:Z100`;
      }
      const res = await client.request({
        method: 'GET',
        url: `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(target)}`,
      });
      const vr = res?.data?.valueRange ?? res?.valueRange ?? {};
      return ok({ range: vr.range, values: vr.values ?? [] });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'sheet_write',
  '写入飞书电子表格的单元格区域（覆盖写）。values 为二维数组，如 [["姓名","金额"],["张三",100]]。',
  { url: z.string(), range: z.string().describe('形如 "工作表ID!A1:B2"'), values: z.array(z.array(z.any())) },
  async ({ url, range, values }) => {
    try {
      let { type, token } = parseTarget(url);
      if (type === 'wiki') ({ objToken: token } = await resolveWiki(token));
      const res = await client.request({
        method: 'PUT',
        url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
        data: { valueRange: { range, values } },
      });
      return ok({ updated: res?.data?.updatedCells ?? res?.updatedCells ?? null, range });
    } catch (e) {
      return fail(e);
    }
  }
);

await server.connect(new StdioServerTransport());
console.error('mcp-feishu: ready');
