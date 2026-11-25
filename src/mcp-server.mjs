import { buildInlineMonitorHtml, INLINE_MONITOR_URI } from './inline-monitor-ui.mjs';

const SERVER_INFO = {
  name: 'chrome-live-for-antigravity',
  version: '1.0.0'
};

const MCP_RESOURCES = [
  {
    uri: INLINE_MONITOR_URI,
    name: 'Chrome Live Inline Monitor',
    description: 'Live Chrome screencast stream rendered directly inline inside the chat conversation.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: false
      }
    }
  }
];

const MCP_TOOLS = [
  {
    name: 'chrome_live_monitor',
    title: 'Chrome Live Inline Monitor',
    description:
      'Render a live, auto-updating Chrome screencast preview card directly inline in the foreground chat conversation (without opening any right-hand side pane). Call once with optional tabId when starting a visual browser task; the action fields are used internally by interactive buttons inside the card.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Optional target tabId to focus in the inline stream' },
        action: {
          type: 'string',
          enum: [
            'poll',
            'screenshot',
            'focus_tab',
            'release_tab',
            'relay_popout',
            'relay_merge',
            'remote_click',
            'remote_wheel',
            'remote_type',
            'inspect_region'
          ],
          description: 'Internal UI callback action (omit when mounting from the model)'
        },
        lastFrameTs: { type: 'number', description: 'Internal poll timestamp' },
        rx: { type: 'number' },
        ry: { type: 'number' },
        rx1: { type: 'number' },
        ry1: { type: 'number' },
        rx2: { type: 'number' },
        ry2: { type: 'number' },
        deltaY: { type: 'number' },
        text: { type: 'string' },
        submit: { type: 'boolean' }
      },
      additionalProperties: false
    },
    _meta: {
      ui: {
        resourceUri: INLINE_MONITOR_URI,
        visibility: ['model', 'app']
      }
    }
  },
  {
    name: 'chrome_live_workspace',
    title: 'Chrome Live Console',
    description:
      'Open the Chrome Live interactive MCP App in Antigravity side pane (aux_pane) or full-page sidebar workspace (global) with live stream, tab switcher, remote control, and Attach-to-Prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Optional target tabId to focus initially' }
      },
      additionalProperties: false
    },
    _meta: {
      ui: {
        resourceUri: INLINE_MONITOR_URI,
        visibility: ['model', 'app']
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Chrome Live' },
          { type: 'global', title: 'Chrome Live' }
        ]
      }
    }
  },
  {
    name: 'chrome_live_status',
    description:
      'Check local Chrome bridge health, shared signed-in tabs, and controlled background tab groups.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_open',
    description:
      'Open a URL inside a background Chrome tab group without stealing foreground focus.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP/HTTPS URL to open' },
        label: { type: 'string', description: 'Short task label shown in the floating HUD pill' },
        background: { type: 'boolean', description: 'Keep tab in background (default true)' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_snapshot',
    description:
      'Read page visible text and interactive DOM elements indexed as [0], [1], [2]... for deterministic clicking and typing.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Optional target tabId (defaults to shared or active controlled tab)' },
        maxItems: { type: 'integer', description: 'Maximum interactive elements to index (default 90)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_click',
    description: 'Click an interactive element by its snapshot index number or visible text.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Element index from chrome_live_snapshot or exact visible label'
        },
        tabId: { type: 'integer', description: 'Optional target tabId' }
      },
      required: ['target'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_type',
    description: 'Fill text into an input/textarea/contenteditable element and optionally submit.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Element index from chrome_live_snapshot or selector/label'
        },
        text: { type: 'string', description: 'Text value to enter' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
        tabId: { type: 'integer', description: 'Optional target tabId' }
      },
      required: ['target', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_upload',
    description:
      'Upload one or more local files (images, attachments, documents) into a page file input or rich-text composer via native CDP DOM.setFileInputFiles.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Local file path(s) to upload'
        },
        target: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Optional snapshot index, CSS selector, or upload button label (defaults to "auto")'
        },
        tabId: { type: 'integer', description: 'Optional target tabId' }
      },
      required: ['files'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_scroll',
    description: 'Scroll the target tab vertically.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
        amount: { type: 'integer', description: 'Pixels to scroll (default 600)' },
        tabId: { type: 'integer', description: 'Optional target tabId' }
      },
      required: ['direction'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_navigate',
    description: 'Navigate an existing controlled or shared tab to a new HTTP/HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Destination HTTP/HTTPS URL' },
        tabId: { type: 'integer', description: 'Optional target tabId' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_extract',
    description:
      'Concurrently extract clean article/DOM text and high-resolution image URLs from one or more URLs in a minimized worker window, closing only its own worker tabs upon completion.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'List of HTTP/HTTPS URLs to extract'
        },
        scrollSteps: { type: 'integer', description: 'Lazy-load scroll steps (default 1)' }
      },
      required: ['urls'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_batch',
    description:
      'Execute a multi-step browser pipeline in a single roundtrip (e.g. open/navigate -> type -> click/submit -> wait for selector or load -> snapshot), automatically threading tabId across steps.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Optional starting tabId' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          description:
            'Ordered steps: each object specifies "action" ("open"|"navigate"|"type"|"click"|"scroll"|"wait"|"snapshot"|"done") plus action parameters (url, target, text, submit, ms, selector, maxItems, etc.)',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['open', 'navigate', 'type', 'click', 'upload', 'scroll', 'wait', 'snapshot', 'screenshot', 'done']
              },
              url: { type: 'string' },
              label: { type: 'string' },
              target: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
              text: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              file: { type: 'string' },
              submit: { type: 'boolean' },
              direction: { type: 'string' },
              amount: { type: 'integer' },
              ms: { type: 'integer' },
              selector: { type: 'string' },
              maxItems: { type: 'integer' },
              summary: { type: 'string' }
            },
            required: ['action']
          }
        }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_playbook',
    description:
      'Manage local opt-in Site Playbooks (direct deep-link routes, stable CSS selectors, and UI widget tips per domain so repeat visits jump in 1 step).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'enable', 'disable', 'list', 'save', 'clear'],
          description: 'Playbook operation'
        },
        domain: { type: 'string', description: 'Target domain (e.g. seller.example.com)' },
        routeName: { type: 'string', description: 'Route title when action="save"' },
        routeUrl: { type: 'string', description: 'Direct route URL when action="save"' },
        selectorName: { type: 'string', description: 'Element alias when action="save"' },
        selectorCss: { type: 'string', description: 'Stable CSS selector when action="save"' },
        tip: { type: 'string', description: 'UI quirk note (e.g. read-only date picker workaround)' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_live_done',
    description:
      'Mark task finished, detach CDP debugger for zero idle CPU overhead, and close temporary worker tabs (never closes user-shared tabs).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Short completion summary shown briefly in the HUD' },
        tabId: { type: 'integer', description: 'Optional target tabId' }
      },
      additionalProperties: false
    }
  }
];

export function startMcpStdioServer({ callDaemon }) {
  let framingMode = 'line'; // 'line' (MCP 2024-11-05+) or 'header' (Content-Length)
  let rawBuffer = Buffer.alloc(0);

  function writeMessage(obj) {
    const json = JSON.stringify(obj);
    if (framingMode === 'header') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }

  async function handleRpc(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;

    if (id === undefined || id === null) {
      // Notifications such as notifications/initialized require no response.
      return;
    }

    try {
      if (method === 'initialize') {
        const clientVersion = params?.protocolVersion || '2024-11-05';
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: clientVersion,
            capabilities: {
              tools: {},
              resources: {}
            },
            serverInfo: SERVER_INFO
          }
        });
        return;
      }

      if (method === 'ping') {
        writeMessage({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/list') {
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: { tools: MCP_TOOLS }
        });
        return;
      }

      if (method === 'resources/list') {
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: { resources: MCP_RESOURCES }
        });
        return;
      }

      if (method === 'resources/read') {
        const uri = params?.uri;
        if (uri !== INLINE_MONITOR_URI) {
          writeMessage({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown resource URI: ${uri}` }
          });
          return;
        }
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri: INLINE_MONITOR_URI,
                mimeType: 'text/html;profile=mcp-app',
                text: buildInlineMonitorHtml(),
                _meta: {
                  ui: {
                    prefersBorder: false
                  }
                }
              }
            ]
          }
        });
        return;
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const output = await invokeTool(toolName, args, callDaemon);
        if (output && typeof output === 'object' && output.__mcpRawResult) {
          writeMessage({
            jsonrpc: '2.0',
            id,
            result: output.__mcpRawResult
          });
          return;
        }
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof output === 'string' ? output : JSON.stringify(output, null, 2)
              }
            ]
          }
        });
        return;
      }

      writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    } catch (err) {
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: err instanceof Error ? err.message : String(err)
            }
          ]
        }
      });
    }
  }

  process.stdin.on('data', (chunk) => {
    rawBuffer = rawBuffer.length === 0 ? chunk : Buffer.concat([rawBuffer, chunk]);

    while (rawBuffer.length > 0) {
      const asciiHead = rawBuffer.subarray(0, Math.min(rawBuffer.length, 32)).toString('utf8');
      if (/^Content-Length:/i.test(asciiHead)) {
        framingMode = 'header';
        const sepIdx = rawBuffer.indexOf('\r\n\r\n');
        if (sepIdx === -1) return;
        const headerStr = rawBuffer.subarray(0, sepIdx).toString('utf8');
        const m = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          rawBuffer = rawBuffer.subarray(sepIdx + 4);
          continue;
        }
        const contentLen = Number.parseInt(m[1], 10);
        const totalNeeded = sepIdx + 4 + contentLen;
        if (rawBuffer.length < totalNeeded) return;
        const bodyStr = rawBuffer.subarray(sepIdx + 4, totalNeeded).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalNeeded);
        try {
          handleRpc(JSON.parse(bodyStr));
        } catch {}
      } else {
        const nlIdx = rawBuffer.indexOf(0x0a);
        if (nlIdx === -1) return;
        const line = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
        rawBuffer = rawBuffer.subarray(nlIdx + 1);
        if (!line) continue;
        framingMode = 'line';
        try {
          handleRpc(JSON.parse(line));
        } catch {}
      }
    }
  });
}

async function buildMonitorStructuredState(callDaemon, lastFrameTs = 0, targetTabId = undefined, forceSnap = false) {
  const hasTab = typeof targetTabId === 'number' && Number.isInteger(targetTabId);
  if (forceSnap && hasTab) {
    await callDaemon('POST', '/api/command', {
      method: 'screenshot',
      params: { tabId: targetTabId }
    }).catch(() => {});
  }
  const tabQuery = hasTab ? `&tabId=${encodeURIComponent(String(targetTabId))}` : '';
  const baseState = await callDaemon('GET', '/api/state');
  const serverFrameTs = baseState?.latestFrameMeta?.capturedAt || 0;
  const cachedIds = Array.isArray(baseState?.cachedFrameTabIds) ? baseState.cachedFrameTabIds : [];
  let fullState = baseState;
  if (hasTab && cachedIds.includes(targetTabId)) {
    if (lastFrameTs === 0 || serverFrameTs !== lastFrameTs) {
      fullState = await callDaemon('GET', `/api/state?includeFrame=1${tabQuery}`);
    }
  } else if (serverFrameTs && serverFrameTs !== lastFrameTs) {
    fullState = await callDaemon('GET', `/api/state?includeFrame=1${tabQuery}`);
  } else if (!baseState?.hasFrame && Array.isArray(baseState?.tabs) && baseState.tabs.length > 0 && lastFrameTs === 0) {
    const snapTid = hasTab ? targetTabId : baseState.tabs[0].tabId;
    await callDaemon('POST', '/api/command', {
      method: 'screenshot',
      params: { tabId: snapTid }
    }).catch(() => {});
    fullState = await callDaemon('GET', `/api/state?includeFrame=1&tabId=${encodeURIComponent(String(snapTid))}`);
  }
  return fullState;
}

async function executeMonitorAppAction(args, callDaemon) {
  const act = String(args?.action || '');
  if (act === 'poll') {
    const targetTabId = typeof args?.tabId === 'number' ? args.tabId : undefined;
    const sc = await buildMonitorStructuredState(callDaemon, Number(args?.lastFrameTs) || 0, targetTabId, false);
    return {
      __mcpRawResult: {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: sc
      }
    };
  }

  let regionResult = null;
  if (
    act === 'screenshot' ||
    act === 'focus_tab' ||
    act === 'release_tab' ||
    act === 'relay_popout' ||
    act === 'relay_merge'
  ) {
    await callDaemon('POST', '/api/command', {
      method: act,
      params: { tabId: args.tabId }
    }).catch(() => {});
  } else if (act === 'remote_click') {
    await callDaemon('POST', '/api/command', {
      method: 'remote_interact',
      params: { kind: 'click', tabId: args.tabId, rx: args.rx, ry: args.ry }
    }).catch(() => {});
  } else if (act === 'remote_wheel') {
    await callDaemon('POST', '/api/command', {
      method: 'remote_interact',
      params: { kind: 'wheel', tabId: args.tabId, deltaY: args.deltaY }
    }).catch(() => {});
  } else if (act === 'remote_type') {
    await callDaemon('POST', '/api/command', {
      method: 'remote_interact',
      params: {
        kind: 'key_text',
        tabId: args.tabId,
        text: args.text || '',
        submit: Boolean(args.submit)
      }
    }).catch(() => {});
  } else if (act === 'inspect_region') {
    const reg = await callDaemon('POST', '/api/command', {
      method: 'inspect_region',
      params: {
        tabId: args.tabId,
        rx1: args.rx1,
        ry1: args.ry1,
        rx2: args.rx2,
        ry2: args.ry2
      }
    }).catch(() => null);
    regionResult = reg?.result || null;
  }
  const targetTabId = typeof args?.tabId === 'number' ? args.tabId : undefined;
  const sc = await buildMonitorStructuredState(callDaemon, 0, targetTabId, false);
  if (regionResult && sc && typeof sc === 'object') {
    sc.regionResult = regionResult;
  }
  return {
    __mcpRawResult: {
      content: [{ type: 'text', text: act || 'ok' }],
      structuredContent: sc
    }
  };
}

async function invokeTool(toolName, args, callDaemon) {
  switch (toolName) {
    case 'chrome_live_monitor':
    case 'chrome_live_workspace': {
      if (toolName === 'chrome_live_monitor' && args && typeof args.action === 'string' && args.action.length > 0) {
        return await executeMonitorAppAction(args, callDaemon);
      }
      const targetTabId = typeof args?.tabId === 'number' ? args.tabId : undefined;
      const sc = await buildMonitorStructuredState(callDaemon, 0, targetTabId, targetTabId !== undefined);
      const tabCount = Array.isArray(sc?.tabs) ? sc.tabs.length : 0;
      const label =
        toolName === 'chrome_live_workspace'
          ? 'Chrome Live workspace app opened'
          : 'Inline live Chrome monitor mounted in chat';
      return {
        __mcpRawResult: {
          content: [
            {
              type: 'text',
              text: `${label} (connected=${Boolean(sc?.extensionConnected)}, activeTabs=${tabCount}).`
            }
          ],
          structuredContent: sc
        }
      };
    }
    case 'chrome_live_app_poll': {
      return await executeMonitorAppAction({ ...args, action: 'poll' }, callDaemon);
    }
    case 'chrome_live_app_action': {
      return await executeMonitorAppAction(args, callDaemon);
    }
    case 'chrome_live_status':
      return await callDaemon('GET', '/api/health');
    case 'chrome_live_open':
      return await callDaemon('POST', '/api/command', {
        method: 'open',
        params: {
          url: args.url,
          label: args.label || '',
          background: args.background !== false
        }
      });
    case 'chrome_live_snapshot':
      return await callDaemon('POST', '/api/command', {
        method: 'snapshot',
        params: {
          tabId: args.tabId,
          maxItems: args.maxItems || 90
        }
      });
    case 'chrome_live_click':
      return await callDaemon('POST', '/api/command', {
        method: 'click',
        params: {
          target: args.target,
          tabId: args.tabId
        }
      });
    case 'chrome_live_type':
      return await callDaemon('POST', '/api/command', {
        method: 'type',
        params: {
          target: args.target,
          text: args.text,
          submit: Boolean(args.submit),
          tabId: args.tabId
        }
      });
    case 'chrome_live_upload':
      return await callDaemon('POST', '/api/command', {
        method: 'upload',
        params: {
          target: args.target ?? 'auto',
          files: args.files,
          tabId: args.tabId
        }
      });
    case 'chrome_live_scroll':
      return await callDaemon('POST', '/api/command', {
        method: 'scroll',
        params: {
          direction: args.direction || 'down',
          amount: args.amount || 600,
          tabId: args.tabId
        }
      });
    case 'chrome_live_navigate':
      return await callDaemon('POST', '/api/command', {
        method: 'navigate',
        params: {
          url: args.url,
          tabId: args.tabId
        }
      });
    case 'chrome_live_extract':
      return await callDaemon('POST', '/api/command', {
        method: 'extract',
        params: {
          urls: args.urls,
          scrollSteps: args.scrollSteps ?? 1
        },
        timeoutMs: 45000
      });
    case 'chrome_live_batch':
      return await callDaemon(
        'POST',
        '/api/command',
        {
          method: 'batch',
          params: {
            tabId: args.tabId,
            steps: args.steps
          },
          timeoutMs: 55000
        },
        60000
      );
    case 'chrome_live_playbook': {
      const act = args.action;
      if (act === 'status' || act === 'list') {
        const q = args.domain ? `?domain=${encodeURIComponent(args.domain)}` : '';
        return await callDaemon('GET', `/api/playbook${q}`);
      }
      if (act === 'enable' || act === 'disable') {
        return await callDaemon('POST', '/api/playbook', {
          action: 'set_enabled',
          enabled: act === 'enable'
        });
      }
      if (act === 'clear') {
        return await callDaemon('POST', '/api/playbook', {
          action: 'clear',
          domain: args.domain || ''
        });
      }
      if (act === 'save') {
        return await callDaemon('POST', '/api/playbook', {
          action: 'save',
          domain: args.domain,
          route:
            args.routeName && args.routeUrl
              ? { name: args.routeName, url: args.routeUrl }
              : undefined,
          selector:
            args.selectorName && args.selectorCss
              ? { name: args.selectorName, css: args.selectorCss }
              : undefined,
          tip: args.tip
        });
      }
      throw new Error(`Unsupported playbook action: ${act}`);
    }
    case 'chrome_live_done':
      return await callDaemon('POST', '/api/command', {
        method: 'done',
        params: {
          summary: args.summary || 'Completed',
          tabId: args.tabId
        }
      });
    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}
