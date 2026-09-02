/**
 * The launch route's `agent.upsert` publish must carry the `hasStream` flag,
 * like every other `agent.upsert` publish site. `applyAgentUpsert` on the web
 * side replaces the cached agent wholesale, so an unflagged payload drops the
 * field from the cached row.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";

import { registerTemplateRoutes } from "../src/routes/templates.js";

const LAUNCHED_AGENT = {
  id: "agt_launched",
  name: "launch-tmpl",
  cwd: "/tmp",
  status: "running",
};

let app: FastifyInstance;
let publishUiEvent: ReturnType<typeof vi.fn>;
let launchTemplate: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  publishUiEvent = vi.fn();
  launchTemplate = vi.fn(async () => ({
    agent: LAUNCHED_AGENT,
    templateId: "tmpl-1",
    templateName: "launch-tmpl",
  }));

  app = Fastify();
  await app.register(fastifyMultipart);
  await registerTemplateRoutes(app, {
    templateService: { launchTemplate } as never,
    publishUiEvent,
    withStreamFlag: ((agent: object) => ({
      ...agent,
      hasStream: true,
    })) as never,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  publishUiEvent.mockClear();
});

describe("POST /api/v1/templates/:id/launch", () => {
  it("publishes agent.upsert with the stream flag applied", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/templates/tmpl-1/launch",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(publishUiEvent).toHaveBeenCalledWith({
      type: "agent.upsert",
      agent: { ...LAUNCHED_AGENT, hasStream: true },
    });
  });

  it("still returns the unflagged agent in the HTTP response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/templates/tmpl-1/launch",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(res.json()).toEqual({ agent: LAUNCHED_AGENT });
  });
});
