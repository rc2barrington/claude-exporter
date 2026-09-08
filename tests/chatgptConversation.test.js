import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await import("../chrome-extension/chatgptConversation.js");
});

const message = (id, role, text, extra = {}) => ({
  id,
  author: { role },
  content: { content_type: "text", parts: [text] },
  metadata: {},
  ...extra,
});

describe("ChatGPTConversationGraph", () => {
  it("strips a human-readable project slug from the API project id", () => {
    const path = "/g/g-p-6a5c33549ce4819182aba041579f5fff-ro-stuff/c/conversation-id";
    expect(globalThis.ChatGPTConversationGraph.projectIdFromPath(path)).toBe(
      "g-p-6a5c33549ce4819182aba041579f5fff"
    );
    expect(globalThis.ChatGPTConversationGraph.projectIdFromPath(
      "/g/g-p-6a5c33549ce4819182aba041579f5fff/c/conversation-id"
    )).toBe("g-p-6a5c33549ce4819182aba041579f5fff");
  });

  it("omits the account header for personal workspaces only", () => {
    expect(globalThis.ChatGPTConversationGraph.accountHeader({
      id: "personal-account-id",
      structure: "personal",
    })).toEqual({});
    expect(globalThis.ChatGPTConversationGraph.accountHeader({
      id: "business-workspace-id",
      structure: "workspace",
    })).toEqual({ "ChatGPT-Account-ID": "business-workspace-id" });
  });

  it("removes project-only headers from ChatGPT file requests", () => {
    expect(globalThis.ChatGPTConversationGraph.fileRequestHeaders({
      Authorization: "Bearer local-session-token",
      "ChatGPT-Account-ID": "business-workspace-id",
      "chatgpt-project-id": "g-p-project",
      "ChatGPT-Conv-Owner-Id": "owner-id",
      "OAI-Device-Id": "device-id",
    })).toEqual({
      Authorization: "Bearer local-session-token",
      "ChatGPT-Account-ID": "business-workspace-id",
      "OAI-Device-Id": "device-id",
    });
  });

  it("follows only the active parent chain and drops abandoned edits", () => {
    const conversation = {
      current_node: "a-new",
      mapping: {
        root: { id: "root", parent: null, children: ["u-old", "u-new"], message: null },
        "u-old": { id: "u-old", parent: "root", children: ["a-old"], message: message("u-old", "user", "OLD QUESTION") },
        "a-old": { id: "a-old", parent: "u-old", children: [], message: message("a-old", "assistant", "ABANDONED REPLY") },
        "u-new": { id: "u-new", parent: "root", children: ["tool", "a-new"], message: message("u-new", "user", "CURRENT QUESTION") },
        tool: {
          id: "tool",
          parent: "u-new",
          children: ["a-new"],
          message: message("tool", "assistant", "INTERNAL TOOL CALL", { recipient: "browser" }),
        },
        "a-new": { id: "a-new", parent: "tool", children: [], message: message("a-new", "assistant", "CURRENT REPLY") },
      },
    };

    const out = globalThis.ChatGPTConversationGraph.activeMessages(conversation);
    expect(out.map((m) => m.id)).toEqual(["u-new", "a-new"]);
    expect(out.map((m) => m.role)).toEqual(["## You", "## ChatGPT"]);
    expect(JSON.stringify(out)).not.toContain("OLD QUESTION");
    expect(JSON.stringify(out)).not.toContain("ABANDONED REPLY");
    expect(JSON.stringify(out)).not.toContain("INTERNAL TOOL CALL");
  });

  it("keeps visible messages around hidden graph nodes in the correct order", () => {
    const conversation = {
      current_node: "a2",
      mapping: {
        u1: { id: "u1", parent: null, message: message("u1", "user", "one") },
        hidden: {
          id: "hidden",
          parent: "u1",
          message: message("hidden", "assistant", "hidden", {
            metadata: { is_visually_hidden_from_conversation: true },
          }),
        },
        a1: { id: "a1", parent: "hidden", message: message("a1", "assistant", "two") },
        u2: { id: "u2", parent: "a1", message: message("u2", "user", "three") },
        a2: { id: "a2", parent: "u2", message: message("a2", "assistant", "four") },
      },
    };

    expect(globalThis.ChatGPTConversationGraph.activeMessages(conversation).map((m) => m.text))
      .toEqual(["one", "two", "three", "four"]);
  });

  it("preserves attachment names and multimodal text", () => {
    const msg = message("u", "user", "describe this", {
      content: {
        content_type: "multimodal_text",
        parts: [{ content_type: "image_asset_pointer" }, "describe this"],
      },
      metadata: { attachments: [{ name: "photo.png" }] },
    });

    expect(globalThis.ChatGPTConversationGraph.contentText(msg)).toBe(
      "*Attached: photo.png*\n\n*Image attached*\n\ndescribe this"
    );
  });

  it("extracts original uploads and merges matching image pointers", () => {
    const msg = message("u", "user", "use these", {
      content: {
        content_type: "multimodal_text",
        parts: [
          {
            content_type: "image_asset_pointer",
            asset_pointer: "file-service://file_image_123",
          },
          "use these",
        ],
      },
      metadata: {
        attachments: [
          {
            id: "file_notes_456",
            name: "source-notes.md",
            mime_type: "text/markdown",
          },
          {
            id: "file_image_123",
            name: "original-photo.webp",
            mime_type: "image/webp",
          },
        ],
      },
    });

    expect(globalThis.ChatGPTConversationGraph.messageAttachments(msg)).toEqual([
      {
        fileId: "file_notes_456",
        url: null,
        name: "source-notes.md",
        mimeType: "text/markdown",
        pointerType: null,
        kind: "attachment",
      },
      {
        fileId: "file_image_123",
        url: null,
        name: "original-photo.webp",
        mimeType: "image/webp",
        pointerType: "image_asset_pointer",
        kind: "image",
      },
    ]);
  });

  it("recognizes current ChatGPT asset pointer and download URL forms", () => {
    const helper = globalThis.ChatGPTConversationGraph;
    expect(helper.cleanAssetId("sediment://file_abc123")).toBe("file_abc123");
    expect(helper.cleanAssetId("file-service://file_def456")).toBe("file_def456");
    expect(helper.cleanAssetId(
      "https://chatgpt.com/backend-api/files/download/file_xyz789?download_intent=true"
    )).toBe("file_xyz789");
  });

  it("extracts exact file ids from rendered Estuary and signed download URLs", () => {
    const helper = globalThis.ChatGPTConversationGraph;
    expect(helper.renderedMediaFileIds(
      "https://chatgpt.com/backend-api/estuary/content?id=file_image_123&ts=1&sig=signed"
    )).toEqual(["file_image_123"]);
    expect(helper.renderedMediaFileIds(
      "https://files.oaiusercontent.com/file_upload_456/download?token=signed"
    )).toEqual(["file_upload_456"]);
    expect(helper.renderedMediaFileIds(
      "https://chatgpt.com/backend-api/files/download/file_shared%23preview?download_intent=true"
    )).toEqual(["file_shared*preview"]);
    expect(helper.renderedMediaFileIds("https://example.com/photo.png")).toEqual([]);
  });

  it("builds the canonical pointer and two-stage file ownership request", () => {
    const helper = globalThis.ChatGPTConversationGraph;
    expect(helper.canonicalAssetPointer("file_upload_123?shared_conversation_id=share-1"))
      .toBe("sediment://file_upload_123?shared_conversation_id=share-1");
    expect(helper.canonicalAssetPointer("asset_456"))
      .toBe("file-service://asset_456");

    const endpoint = helper.fileInfoEndpoint(
      "sediment://file_upload_123",
      "https://chatgpt.com",
      { gizmoId: "g-p-project", conversationId: "conversation-1" }
    );
    expect(endpoint.pathname).toBe("/backend-api/files/file_upload_123/simple");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      gizmo_id: "g-p-project",
      conversation_id: "conversation-1",
    });
  });

  it("uses ChatGPT's Library ownership rules for the effective gizmo", () => {
    const helper = globalThis.ChatGPTConversationGraph;
    expect(helper.effectiveGizmoIdFromFileInfo("g-p-route", {
      is_library_file: false,
    })).toBe("g-p-route");
    expect(helper.effectiveGizmoIdFromFileInfo("g-p-route", {
      is_library_file: true,
      is_project: true,
      gizmo_id: "g-p-owner",
    })).toBe("g-p-owner");
    expect(helper.effectiveGizmoIdFromFileInfo("g-p-route", {
      is_library_file: true,
      is_project: false,
      gizmo_id: "g-library-owner",
    })).toBeNull();
  });

  it("discovers ChatGPT's current file client through hashed route imports", () => {
    const source = [
      'import{D0 as n,vu as _,yd as v}from"./4813494d-file-client.js";',
      'import{w as T}from"./query-client.js";',
      'function j(e){return T({queryKey:[`getFileDownloadLink`,e],',
      'queryFn:()=>_(e,{downloadIntent:!1}),staleTime:v})}',
    ].join("");

    expect(globalThis.ChatGPTConversationGraph.currentFileResolverImport(
      source,
      "https://chatgpt.com/cdn/assets/a366adf3-route.js"
    )).toEqual({
      moduleUrl: "https://chatgpt.com/cdn/assets/4813494d-file-client.js",
      exportName: "vu",
    });
  });

  it("does not mistake unrelated hashed bundles for the file resolver", () => {
    expect(globalThis.ChatGPTConversationGraph.currentFileResolverImport(
      'import{x as y}from"./other.js";const queryFn=()=>y();',
      "https://chatgpt.com/cdn/assets/unrelated.js"
    )).toBeNull();
  });

  it("reproduces ChatGPT's integrity observation header without exposing the cookie", () => {
    const helper = globalThis.ChatGPTConversationGraph;
    expect(helper.integrityObservationHeader("other=value")).toBe("v1.r.m");
    expect(helper.integrityObservationHeader(
      "other=value; __Secure-oai-is=ois1.first.ABCDEFGHIJKLMNOP.last"
    )).toBe("v1.r.p.ABCDEFGHIJKLMNOP");
    expect(helper.integrityObservationHeader("__Secure-oai-is=invalid"))
      .toBe("v1.r.i");
  });

  it("preserves ChatGPT file authorization context carried by an asset pointer", () => {
    const helper = globalThis.ChatGPTConversationGraph;
    const pointer =
      "file-service://file_shared#preview?shared_conversation_id=share-123";

    expect(helper.fileDownloadReference(pointer)).toBe(
      "file_shared#preview?shared_conversation_id=share-123"
    );
    expect(helper.cleanAssetId(pointer)).toBe("file_shared*preview");

    const endpoint = helper.fileDownloadEndpoint(pointer, "https://chatgpt.com", {
      gizmoId: "g-p-project",
      postId: "post-456",
      downloadIntent: true,
      checkContextScopesForConversationId: "conversation-789",
    });
    expect(endpoint.pathname).toBe(
      "/backend-api/files/download/file_shared*preview"
    );
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      shared_conversation_id: "share-123",
      gizmo_id: "g-p-project",
      post_id: "post-456",
      download_intent: "true",
      check_context_scopes_for_conversation_id: "conversation-789",
    });
  });

  it("retains file, post, project, and library metadata needed for downloads", () => {
    const msg = message("u", "user", "file contexts", {
      metadata: {
        attachments: [{
          id: "file_doc?shared_conversation_id=share-1",
          name: "brief.md",
          mime_type: "text/markdown",
          conversation_id: "conversation-1",
          check_context_scopes_for_conversation_id: "scope-conversation-1",
          gizmo_id: "g-p-project",
          post_id: "post-1",
          library_file_id: "library-file-1",
          mounted_library_file_id: "mounted-file-1",
          library_download_id: "library-download-1",
          shared_library_file_id: "shared-library-1",
        }],
      },
    });

    expect(globalThis.ChatGPTConversationGraph.messageAttachments(msg)).toEqual([
      expect.objectContaining({
        fileId: "file_doc",
        fileReference: "file_doc?shared_conversation_id=share-1",
        conversationId: "conversation-1",
        checkContextScopesForConversationId: "scope-conversation-1",
        gizmoId: "g-p-project",
        postId: "post-1",
        libraryFileId: "library-file-1",
        mountedLibraryFileId: "mounted-file-1",
        libraryDownloadId: "library-download-1",
        sharedLibraryFileId: "shared-library-1",
      }),
    ]);
  });

  it("extracts nested audio, video, frame, and data-backed media parts", () => {
    const msg = message("u", "user", "multimedia", {
      content: {
        content_type: "multimodal_text",
        parts: [
          {
            content_type: "real_time_user_audio_video_asset_pointer",
            audio_asset_pointer: { asset_pointer: "sediment://file_audio" },
            video_container_asset_pointer: { asset_pointer: "file-service://file_video" },
            frames_asset_pointers: ["file-service://file_frame_1"],
          },
          {
            content_type: "image",
            payload: "data:image/png;base64,aGVsbG8=",
            mime_type: "image/png",
            name: "inline.png",
          },
        ],
      },
    });

    expect(globalThis.ChatGPTConversationGraph.messageAttachments(msg)).toEqual([
      expect.objectContaining({ fileId: "file_audio", kind: "audio" }),
      expect.objectContaining({ fileId: "file_video", kind: "video" }),
      expect.objectContaining({ fileId: "file_frame_1", kind: "image" }),
      expect.objectContaining({
        fileId: null,
        url: "data:image/png;base64,aGVsbG8=",
        name: "inline.png",
        kind: "image",
      }),
    ]);
  });

  it("retains nested signed media URLs and their ownership context", () => {
    const signedUrl =
      "https://chatgpt.com/backend-api/estuary/content?id=file_nested&sig=signed";
    const msg = message("tool", "assistant", "image", {
      metadata: { gizmo_id: "g-image-tool" },
      content: {
        content_type: "multimodal_text",
        parts: [{
          content_type: "image_asset_pointer",
          asset: {
            asset_pointer: "sediment://file_nested",
            preview: { url: signedUrl },
            check_context_scopes_for_conversation_id: "conversation-scope",
          },
        }],
      },
    });

    expect(globalThis.ChatGPTConversationGraph.messageAttachments(msg)).toEqual([
      expect.objectContaining({
        fileId: "file_nested",
        url: signedUrl,
        gizmoId: "g-image-tool",
        checkContextScopesForConversationId: "conversation-scope",
      }),
    ]);
  });

  it("keeps attachment metadata on the authoritative active branch", () => {
    const upload = message("u1", "user", "read this", {
      metadata: {
        attachments: [{ id: "file_md", name: "brief.md", mime_type: "text/markdown" }],
      },
    });
    const conversation = {
      current_node: "a1",
      mapping: {
        u1: { id: "u1", parent: null, message: upload },
        a1: { id: "a1", parent: "u1", message: message("a1", "assistant", "done") },
      },
    };

    const active = globalThis.ChatGPTConversationGraph.activeMessages(conversation);
    expect(active[0].attachments).toHaveLength(1);
    expect(active[0].attachments[0]).toMatchObject({
      fileId: "file_md",
      name: "brief.md",
      mimeType: "text/markdown",
      kind: "attachment",
    });
  });

  it("carries generated media from hidden tool nodes into the visible reply", () => {
    const toolImage = {
      id: "tool-image",
      author: { role: "tool" },
      content: {
        content_type: "multimodal_text",
        parts: [{
          content_type: "image_asset_pointer",
          asset_pointer: "sediment://file_generated_image",
          mime_type: "image/png",
        }],
      },
      metadata: {},
    };
    const conversation = {
      current_node: "a2",
      mapping: {
        u1: { id: "u1", parent: null, message: message("u1", "user", "make an image") },
        a1: {
          id: "a1",
          parent: "u1",
          message: message("a1", "assistant", "calling image tool", { recipient: "image" }),
        },
        tool: { id: "tool", parent: "a1", message: toolImage },
        a2: { id: "a2", parent: "tool", message: message("a2", "assistant", "Here it is") },
      },
    };

    const active = globalThis.ChatGPTConversationGraph.activeMessages(conversation);
    expect(active.map(entry => entry.text)).toEqual(["make an image", "Here it is"]);
    expect(active[1].attachments).toEqual([
      expect.objectContaining({
        fileId: "file_generated_image",
        mimeType: "image/png",
        kind: "image",
      }),
    ]);
  });

  it("merges rendered fragments that belong to the same turn", () => {
    const out = globalThis.ChatGPTConversationGraph.collapseAndValidateDomMessages([
      { role: "## You", text: "question", ord: 1 },
      { role: "## ChatGPT", text: "first fragment", ord: 2 },
      { role: "## ChatGPT", text: "second fragment", ord: 2 },
      { role: "## You", text: "follow-up", ord: 3 },
    ]);

    expect(out).toHaveLength(3);
    expect(out[1].text).toBe("first fragment\n\nsecond fragment");
  });

  it("rejects a DOM scan with a provably missing alternating turn", () => {
    expect(() => globalThis.ChatGPTConversationGraph.collapseAndValidateDomMessages([
      { role: "## You", text: "one", ord: 1 },
      { role: "## ChatGPT", text: "two", ord: 2 },
      { role: "## ChatGPT", text: "four", ord: 4 },
    ])).toThrow("missing turn between positions 2 and 3");
  });

  it("paginates through ChatGPT's current web API to the actual first message", async () => {
    const calls = [];
    const fetchImpl = async (endpoint, init) => {
      calls.push({ endpoint, init });
      if (endpoint.includes("/messages?")) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              message("u1", "user", "actual first"),
              message("a1", "assistant", "actual first reply"),
            ],
            page_info: { has_previous_page: false, start_cursor: null },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          current_node: "a2",
          gizmo_id: "g-p-project",
          owner: { user_id: "project-owner" },
          messages: [
            message("u2", "user", "later question"),
            message("a2", "assistant", "latest reply"),
          ],
          page_info: { has_previous_page: true, start_cursor: "older cursor" },
        }),
      };
    };

    const result = await globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "conversation id",
      {
        fetchImpl,
        headers: {
          Authorization: "Bearer local-session-token",
          "chatgpt-project-id": "g-p-project",
        },
      }
    );

    expect(calls.map((call) => call.endpoint)).toEqual([
      "/backend-api/conversations/conversation%20id?include_has_versions=true&num_turns=20",
      "/backend-api/conversations/conversation%20id/messages?before=older%20cursor&include_has_versions=true&num_turns=20",
    ]);
    for (const call of calls) {
      expect(call.init).toMatchObject({
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer local-session-token",
          "chatgpt-project-id": "g-p-project",
        },
      });
    }
    expect(result.messages.map((entry) => entry.text)).toEqual([
      "actual first",
      "actual first reply",
      "later question",
      "latest reply",
    ]);
    expect(result.pages).toBe(2);
    expect(result.source).toBe("paginated");
    expect(result.projectId).toBe("g-p-project");
    expect(result.ownerUserId).toBe("project-owner");
  });

  it("uses ChatGPT's complete singular mapping only as a verified fallback", async () => {
    const calls = [];
    const conversation = {
      current_node: "a1",
      mapping: {
        u1: { id: "u1", parent: null, message: message("u1", "user", "first") },
        a1: { id: "a1", parent: "u1", message: message("a1", "assistant", "reply") },
      },
    };
    const fetchImpl = async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.includes("/conversations/")) {
        return { ok: false, status: 404, json: async () => ({ detail: "not enabled" }) };
      }
      return { ok: true, status: 200, json: async () => conversation };
    };

    const result = await globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "conversation-id",
      { fetchImpl }
    );

    expect(calls).toEqual([
      "/backend-api/conversations/conversation-id?include_has_versions=true&num_turns=20",
      "/backend-api/conversation/conversation-id",
    ]);
    expect(result.source).toBe("complete-mapping-fallback");
    expect(result.messages.map((entry) => entry.text)).toEqual(["first", "reply"]);
  });

  it("rejects an API page whose oldest node still points to an unloaded parent", () => {
    const paginated = {
      current_node: "a-latest",
      mapping: {
        "u-latest": {
          id: "u-latest",
          parent: "older-node-not-returned",
          message: message("u-latest", "user", "not the actual first message"),
        },
        "a-latest": {
          id: "a-latest",
          parent: "u-latest",
          message: message("a-latest", "assistant", "latest reply"),
        },
      },
    };

    expect(() => globalThis.ChatGPTConversationGraph.activeMessages(paginated))
      .toThrow("paginated before the root");
  });

  it("rejects explicit ChatGPT pagination metadata with an older-page cursor", () => {
    const paginated = {
      current_node: "a1",
      __paginatedConversationPage: { cursor: "load-older-page" },
      mapping: {
        u1: { id: "u1", parent: null, message: message("u1", "user", "latest page") },
        a1: { id: "a1", parent: "u1", message: message("a1", "assistant", "reply") },
      },
    };

    expect(() => globalThis.ChatGPTConversationGraph.activeMessages(paginated))
      .toThrow("still has older paginated messages");
  });

  it("fails closed when ChatGPT claims an older page but omits its cursor", async () => {
    const fetchImpl = async (endpoint) => {
      if (endpoint.includes("/conversations/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            current_node: "a2",
            messages: [message("a2", "assistant", "latest only")],
            page_info: { has_previous_page: true, start_cursor: null },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          current_node: "a2",
          mapping: {
            a2: {
              id: "a2",
              parent: "missing-parent",
              message: message("a2", "assistant", "latest only"),
            },
          },
        }),
      };
    };

    await expect(globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "conversation-id",
      { fetchImpl }
    )).rejects.toThrow("returned no start_cursor");
  });

  it("fails closed when a pagination cursor repeats", async () => {
    const fetchImpl = async (endpoint) => ({
      ok: true,
      status: 200,
      json: async () => endpoint.includes("/messages?")
        ? {
            messages: [message("u1", "user", "older")],
            page_info: { has_previous_page: true, start_cursor: "same-cursor" },
          }
        : {
            current_node: "a2",
            messages: [message("a2", "assistant", "newer")],
            page_info: { has_previous_page: true, start_cursor: "same-cursor" },
          },
    });

    await expect(globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "conversation-id",
      { fetchImpl }
    )).rejects.toThrow("repeated cursor same-cursor");
  });

  it("merges overlapping paginated boundary messages like ChatGPT's client", async () => {
    const fetchImpl = async (endpoint) => ({
      ok: true,
      status: 200,
      json: async () => endpoint.includes("/messages?")
        ? {
            messages: [message("duplicate", "user", "older copy")],
            page_info: { has_previous_page: false },
          }
        : {
            current_node: "duplicate",
            messages: [message("duplicate", "assistant", "newer copy")],
            page_info: { has_previous_page: true, start_cursor: "older" },
          },
    });

    const result = await globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "conversation-id",
      { fetchImpl }
    );

    expect(result.messages).toEqual([
      expect.objectContaining({ id: "duplicate", role: "## ChatGPT", text: "newer copy" }),
    ]);
    expect(result.overlappingMessages).toBe(1);
  });

  it("uses the newest paginated message when the server current node is hidden", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        current_node: "hidden-tool-leaf-not-in-page",
        messages: [
          message("u1", "user", "first"),
          message("a1", "assistant", "reply"),
        ],
        page_info: { has_previous_page: false },
      }),
    });

    const result = await globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "conversation-id",
      { fetchImpl }
    );

    expect(result.messages.map(entry => entry.id)).toEqual(["u1", "a1"]);
    expect(result.usedCurrentNodeFallback).toBe(true);
  });

  it("reaches the root of a 309-message conversation across every page", async () => {
    const allMessages = Array.from({ length: 309 }, (_, index) => {
      const number = index + 1;
      return message(
        `message-${number}`,
        number % 2 === 1 ? "user" : "assistant",
        `synthetic turn ${number}`
      );
    });
    const pageSize = 20;
    const calls = [];
    const pageBody = (pageNumber) => {
      const end = allMessages.length - pageNumber * pageSize;
      const start = Math.max(0, end - pageSize);
      return {
        current_node: "hidden-server-leaf",
        messages: allMessages.slice(start, end),
        page_info: {
          has_previous_page: start > 0,
          start_cursor: start > 0 ? `page-${pageNumber + 1}` : null,
        },
      };
    };
    const fetchImpl = async (endpoint) => {
      calls.push(endpoint);
      const cursorMatch = endpoint.match(/[?&]before=page-(\d+)/);
      const pageNumber = cursorMatch ? Number(cursorMatch[1]) : 0;
      return {
        ok: true,
        status: 200,
        json: async () => pageBody(pageNumber),
      };
    };

    const result = await globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "long-conversation",
      { fetchImpl }
    );

    expect(result.pages).toBe(16);
    expect(calls).toHaveLength(16);
    expect(result.messages).toHaveLength(309);
    expect(result.messages[0].id).toBe("message-1");
    expect(result.messages.at(-1).id).toBe("message-309");
    expect(result.usedCurrentNodeFallback).toBe(true);
  });

  it("includes ChatGPT's safe structured error detail in a failed request", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ detail: { code: "workspace_header_mismatch", message: "Request context rejected" } }),
    });

    await expect(globalThis.ChatGPTConversationGraph.fetchActiveMessages(
      "conversation-id",
      { fetchImpl }
    )).rejects.toThrow("workspace_header_mismatch: Request context rejected");
  });
});
