/**
 * migrate MCP server — a deliberately SEPARATE stdio server from codegraph's
 * (`src/mcp/`): the consumer is the external migration agent the work-order
 * briefs point at, the data is three static JSON artifacts (no daemon, no
 * SQLite, no watcher), and keeping it out of the upstream server avoids both
 * the fork's rebase surface and codegraph's default-tool gating.
 *
 * Launch: `migrate serve --mcp [--path <android-root>]`.
 */

import {
  ErrorCodes,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcTransport,
  StdioTransport,
} from '../../mcp/transport';
import { MIGRATE_SERVER_INSTRUCTIONS } from './instructions';
import { MigrateToolHandler } from './tools';

const SERVER_NAME = 'migrate';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

export class MigrateMcpServer {
  private readonly handler: MigrateToolHandler;

  constructor(
    root: string,
    private readonly transport: JsonRpcTransport = new StdioTransport()
  ) {
    this.handler = new MigrateToolHandler(root);
  }

  start(): void {
    this.transport.start(async (message) => this.onMessage(message));
  }

  stop(): void {
    this.transport.stop();
  }

  private async onMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!('id' in message) || message.id === undefined || message.id === null) {
      return; // notifications (e.g. notifications/initialized) need no reply
    }
    const { id, method } = message;
    const params = (message.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'initialize':
        this.transport.sendResult(id, {
          protocolVersion:
            typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: MIGRATE_SERVER_INSTRUCTIONS,
        });
        return;
      case 'tools/list':
        this.transport.sendResult(id, { tools: this.handler.listTools() });
        return;
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!MigrateToolHandler.isKnownTool(name)) {
          this.transport.sendError(id, ErrorCodes.InvalidParams, `未知工具:${name}`);
          return;
        }
        try {
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          this.transport.sendResult(id, this.handler.execute(name, args));
        } catch (err) {
          // A genuine malfunction (not an expected condition) — still answer
          // success-shaped with a retry note so the agent doesn't abandon us.
          this.transport.sendResult(id, {
            content: [
              {
                type: 'text',
                text: `查询失败:${err instanceof Error ? err.message : String(err)}(可重试一次;若持续失败请检查 .migration/ 产物完整性)`,
              },
            ],
          });
        }
        return;
      }
      case 'ping':
        this.transport.sendResult(id, {});
        return;
      default:
        this.transport.sendError(id, ErrorCodes.MethodNotFound, `Method not found: ${method}`);
    }
  }
}
