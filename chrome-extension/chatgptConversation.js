// Converts ChatGPT's conversation mapping into the single active branch that
// the user currently sees. Loaded before contentScript.js and deliberately
// written as a classic script so Chrome can inject it without a bundler.
(function (root) {
  function projectIdFromPath(pathname) {
    const routeEntityId = ((pathname || "").match(/\/g\/([^/?#]+)\/c\//) || [])[1] || null;
    if (!routeEntityId) return null;

    // Project routes may append a display slug, for example:
    // g-p-<32 hex characters>-ro-stuff. The API header accepts only the
    // canonical g-p id. Sending the display slug makes ChatGPT return 403.
    const match = routeEntityId.match(/^(g-p-[0-9a-f]{32})(?:-|$)/i);
    return match ? match[1] : null;
  }

  function accountHeader(account) {
    if (!account || account.structure === "personal") return {};
    return typeof account.id === "string" && account.id
      ? { "ChatGPT-Account-ID": account.id }
      : {};
  }

  function fileRequestHeaders(headers) {
    const output = {};
    for (const [name, value] of Object.entries(headers || {})) {
      const lower = name.toLowerCase();
      if (lower === "chatgpt-project-id" || lower === "chatgpt-conv-owner-id") {
        continue;
      }
      output[name] = value;
    }
    return output;
  }

  function integrityObservationHeader(cookieString) {
    let cookieValue = null;
    try {
      for (const item of String(cookieString || "").split(";")) {
        const separator = item.indexOf("=");
        if (separator < 0) continue;
        if (item.slice(0, separator).trim() !== "__Secure-oai-is") continue;
        cookieValue = decodeURIComponent(item.slice(separator + 1).trim());
        break;
      }
    } catch (error) {
      return "v1.r.r";
    }
    if (cookieValue == null) return "v1.r.m";
    const match = cookieValue.match(
      /^ois1\.[A-Za-z0-9_-]+\.([A-Za-z0-9_-]{16})\.[A-Za-z0-9_-]+$/
    );
    return match ? "v1.r.p." + match[1] : "v1.r.i";
  }

  function cleanAssetId(value) {
    const reference = fileDownloadReference(value);
    if (!reference) return null;
    const queryIndex = reference.indexOf("?");
    const path = queryIndex === -1 ? reference : reference.slice(0, queryIndex);
    return path.replaceAll("#", "*") || null;
  }

  // ChatGPT treats query parameters on an asset pointer as part of the file
  // reference. In particular, shared_conversation_id and
  // include_library_file_state carry the authorization context needed by the
  // download endpoint. Keep that context even though cleanAssetId returns a
  // query-free identity for deduplication.
  function fileDownloadReference(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const input = value.trim();
    const withoutScheme = input.replace(/^(?:file-service|sediment):\/\//i, "");
    if (withoutScheme !== input) return withoutScheme || null;

    try {
      const parsed = new URL(input);
      const pathMatch = parsed.pathname.match(/\/files\/download\/([^/?#]+)/i);
      if (pathMatch) {
        return decodeURIComponent(pathMatch[1]) + parsed.search;
      }
      const id = parsed.searchParams.get("id") || parsed.searchParams.get("file_id");
      return id || null;
    } catch (error) {
      return withoutScheme || null;
    }
  }

  function fileDownloadEndpoint(reference, origin, options = {}) {
    const normalized = fileDownloadReference(reference);
    if (!normalized) return null;

    const queryIndex = normalized.indexOf("?");
    const pathId = (queryIndex === -1 ? normalized : normalized.slice(0, queryIndex))
      .replaceAll("#", "*");
    if (!pathId) return null;

    const endpoint = new URL(
      "/backend-api/files/download/" + encodeURIComponent(pathId),
      origin || "https://chatgpt.com"
    );
    if (queryIndex !== -1) {
      const carried = new URLSearchParams(normalized.slice(queryIndex + 1));
      carried.forEach((value, key) => endpoint.searchParams.set(key, value));
    }

    const setParam = (name, value) => {
      if (value !== undefined && value !== null && value !== "") {
        endpoint.searchParams.set(name, String(value));
      }
    };
    setParam("gizmo_id", options.gizmoId);
    setParam("post_id", options.postId);
    setParam("conversation_id", options.conversationId);
    setParam("inline", options.inline);
    setParam("download_intent", options.downloadIntent);
    setParam(
      "check_context_scopes_for_conversation_id",
      options.checkContextScopesForConversationId
    );
    return endpoint;
  }

  function canonicalAssetPointer(reference) {
    const normalized = fileDownloadReference(reference);
    if (!normalized) return null;
    if (/^(?:file-service|sediment):\/\//i.test(String(reference || "").trim())) {
      return String(reference).trim();
    }
    const path = normalized.split("?", 1)[0];
    const scheme = path.startsWith("file_") ? "sediment://" : "file-service://";
    return scheme + normalized;
  }

  function fileInfoEndpoint(reference, origin, options = {}) {
    const fileId = cleanAssetId(reference);
    if (!fileId) return null;
    const endpoint = new URL(
      "/backend-api/files/" + encodeURIComponent(fileId) + "/simple",
      origin || "https://chatgpt.com"
    );
    if (options.gizmoId) endpoint.searchParams.set("gizmo_id", options.gizmoId);
    if (options.conversationId) {
      endpoint.searchParams.set("conversation_id", options.conversationId);
    }
    return endpoint;
  }

  // This mirrors ChatGPT's current gX helper. Library files can belong to a
  // project other than the route that displays the conversation. Ordinary
  // files keep the requested gizmo context, while non-project Library files
  // deliberately omit it.
  function effectiveGizmoIdFromFileInfo(requestedGizmoId, fileInfo) {
    if (!fileInfo || fileInfo.is_library_file !== true) return requestedGizmoId || null;
    if (fileInfo.is_project === true || String(fileInfo.gizmo_id || "").startsWith("g-p-")) {
      return fileInfo.gizmo_id || requestedGizmoId || null;
    }
    return null;
  }

  // ChatGPT's route chunks use content hashes, so their filenames cannot be
  // used to locate the current file client. Find the small query wrapper that
  // names getFileDownloadLink, identify the imported function it calls, and
  // return that dependency's stable ESM export coordinates. This discovers
  // ChatGPT's authenticated API client without depending on a particular
  // minified filename or export alias.
  function currentFileResolverImport(source, bundleUrl) {
    if (typeof source !== "string" || !source.includes("getFileDownloadLink")) {
      return null;
    }
    if (typeof bundleUrl !== "string" || !bundleUrl) return null;

    const imports = [];
    const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    let importMatch;
    while ((importMatch = importPattern.exec(source))) {
      for (const rawSpecifier of importMatch[1].split(",")) {
        const specifier = rawSpecifier.trim();
        const alias = specifier.match(
          /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/
        );
        const direct = specifier.match(/^([A-Za-z_$][\w$]*)$/);
        if (!alias && !direct) continue;
        imports.push({
          exportName: alias ? alias[1] : direct[1],
          localName: alias ? alias[2] : direct[1],
          specifier: importMatch[2],
        });
      }
    }

    let markerIndex = source.indexOf("getFileDownloadLink");
    while (markerIndex !== -1) {
      const nearby = source.slice(markerIndex, markerIndex + 1600);
      const queryCall = nearby.match(
        /queryFn\s*:\s*(?:async\s*)?\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/
      );
      if (queryCall) {
        const imported = imports.find(entry => entry.localName === queryCall[1]);
        if (imported) {
          try {
            return {
              moduleUrl: new URL(imported.specifier, bundleUrl).href,
              exportName: imported.exportName,
            };
          } catch (error) {
            return null;
          }
        }
      }
      markerIndex = source.indexOf("getFileDownloadLink", markerIndex + 1);
    }
    return null;
  }

  function directAssetUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const input = value.trim();
    if (/^data:(?:image|video|audio)\//i.test(input)) return input;
    try {
      const parsed = new URL(input);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.href
        : null;
    } catch (error) {
      return null;
    }
  }

  function renderedMediaFileIds(value, origin) {
    let url;
    try {
      url = new URL(value, origin || "https://chatgpt.com");
    } catch (error) {
      return [];
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];

    const normalize = fileId => {
      if (!fileId) return null;
      try {
        return decodeURIComponent(String(fileId)).replaceAll("#", "*");
      } catch (error) {
        return String(fileId).replaceAll("#", "*");
      }
    };
    const ids = new Set();
    const pathMatch = url.pathname.match(/\/files\/download\/([^/?#]+)/i);
    for (const fileId of [
      url.searchParams.get("id"),
      url.searchParams.get("file_id"),
      pathMatch && pathMatch[1],
    ]) {
      const normalized = normalize(fileId);
      if (normalized) ids.add(normalized);
    }

    if (!ids.size) {
      let decodedHref = url.href;
      try { decodedHref = decodeURIComponent(decodedHref); } catch (error) {}
      for (const embedded of decodedHref.match(/file[-_][a-z0-9_-]{6,}/gi) || []) {
        const normalized = normalize(embedded);
        if (normalized) ids.add(normalized);
      }
    }
    return Array.from(ids);
  }

  function attachmentKind(mimeType, pointerType) {
    const mime = String(mimeType || "").toLowerCase();
    const type = String(pointerType || "").toLowerCase();
    if (mime.startsWith("image/") || type.includes("image")) return "image";
    if (mime.startsWith("video/") || type.includes("video")) return "video";
    if (mime.startsWith("audio/") || type.includes("audio")) return "audio";
    return "attachment";
  }

  function nestedAssetPointers(part) {
    const pointers = [];
    const seen = new Set();
    const walk = (value, path, depth) => {
      if (depth > 6 || value == null) return;
      if (typeof value === "string") {
        if (!/(?:asset_pointer|asset_pointers|file_id|fileId)/i.test(path)) return;
        const clean = value.trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        pointers.push({ value: clean, path });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(child => walk(child, path, depth + 1));
        return;
      }
      if (typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? path + "." + key : key;
        walk(child, childPath, depth + 1);
      }
    };
    walk(part, "", 0);
    return pointers;
  }

  function nestedAssetUrls(part) {
    const urls = [];
    const seen = new Set();
    const walk = (value, path, depth) => {
      if (depth > 7 || value == null) return;
      if (typeof value === "string") {
        if (!/(?:asset|download|image|audio|video|media|preview|thumbnail|url|uri)/i.test(path)) {
          return;
        }
        const url = directAssetUrl(value);
        if (!url || seen.has(url)) return;
        seen.add(url);
        urls.push(url);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((child, index) => walk(child, path + "[" + index + "]", depth + 1));
        return;
      }
      if (typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? path + "." + key : key, depth + 1);
      }
    };
    walk(part, "", 0);
    return urls;
  }

  function nestedAttachmentContext(value) {
    const aliases = {
      conversationid: "conversationId",
      checkcontextscopesforconversationid: "checkContextScopesForConversationId",
      gizmoid: "gizmoId",
      postid: "postId",
      libraryfileid: "libraryFileId",
      mountedlibraryfileid: "mountedLibraryFileId",
      librarydownloadid: "libraryDownloadId",
      sharedlibraryfileid: "sharedLibraryFileId",
    };
    const output = {};
    const walk = (current, depth) => {
      if (depth > 7 || !current || typeof current !== "object") return;
      if (Array.isArray(current)) {
        current.forEach(child => walk(child, depth + 1));
        return;
      }
      for (const [key, child] of Object.entries(current)) {
        const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        const outputKey = aliases[normalizedKey];
        if (
          outputKey &&
          output[outputKey] == null &&
          typeof child === "string" &&
          child.trim()
        ) {
          output[outputKey] = child.trim();
        }
        if (child && typeof child === "object") walk(child, depth + 1);
      }
    };
    walk(value, 0);
    return output;
  }

  function pointerTypeHint(contentType, path) {
    const value = String(path || "").toLowerCase();
    if (value.includes("frame")) return "image_asset_pointer";
    if (value.includes("image")) return "image_asset_pointer";
    if (value.includes("audio")) return "audio_asset_pointer";
    if (value.includes("video")) return "video_asset_pointer";
    return contentType;
  }

  function messageAttachments(message) {
    if (!message || typeof message !== "object") return [];

    const descriptors = [];
    const byIdentity = new Map();
    const metadataAttachments = message.metadata && Array.isArray(message.metadata.attachments)
      ? message.metadata.attachments
      : [];
    const messageContextSource = { ...(message.metadata || {}) };
    delete messageContextSource.attachments;
    const messageContext = nestedAttachmentContext(messageContextSource);

    const addOrMerge = (candidate) => {
      if (!candidate) return null;
      const fileReference = fileDownloadReference(
        candidate.fileReference || candidate.fileId
      );
      const fileId = cleanAssetId(fileReference);
      const url = directAssetUrl(candidate.url);
      const name = typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : null;
      const mimeType = typeof candidate.mimeType === "string" && candidate.mimeType.trim()
        ? candidate.mimeType.trim()
        : null;
      if (!fileId && !url && !name) return null;

      const identity = fileId
        ? "file:" + fileId
        : url
          ? "url:" + url
          : "name:" + name + ":" + descriptors.length;
      const existing = byIdentity.get(identity);
      if (existing) {
        if (!existing.url && url) existing.url = url;
        if (!existing.name && name) existing.name = name;
        if (!existing.mimeType && mimeType) existing.mimeType = mimeType;
        if (!existing.fileReference && fileReference && fileReference !== fileId) {
          existing.fileReference = fileReference;
        }
        if (candidate.pointerType && !existing.pointerType) {
          existing.pointerType = candidate.pointerType;
        }
        for (const key of [
          "conversationId",
          "checkContextScopesForConversationId",
          "gizmoId",
          "postId",
          "libraryFileId",
          "mountedLibraryFileId",
          "libraryDownloadId",
          "sharedLibraryFileId",
        ]) {
          if (!existing[key] && candidate[key]) existing[key] = candidate[key];
        }
        existing.kind = attachmentKind(
          existing.mimeType || mimeType,
          existing.pointerType || candidate.pointerType
        );
        return existing;
      }

      const descriptor = {
        fileId,
        url,
        name,
        mimeType,
        pointerType: candidate.pointerType || null,
        kind: attachmentKind(mimeType, candidate.pointerType),
      };
      if (fileReference && fileReference !== fileId) {
        descriptor.fileReference = fileReference;
      }
      for (const key of [
        "conversationId",
        "checkContextScopesForConversationId",
        "gizmoId",
        "postId",
        "libraryFileId",
        "mountedLibraryFileId",
        "libraryDownloadId",
        "sharedLibraryFileId",
      ]) {
        if (candidate[key]) descriptor[key] = candidate[key];
      }
      byIdentity.set(identity, descriptor);
      descriptors.push(descriptor);
      return descriptor;
    };

    for (const attachment of metadataAttachments) {
      if (!attachment || typeof attachment !== "object") continue;
      const attachmentContext = nestedAttachmentContext(attachment);
      addOrMerge({
        fileId: attachment.id || attachment.file_id || attachment.asset_pointer,
        url: attachment.download_url || attachment.url || attachment.preview_url ||
          attachment.image_url || attachment.asset_pointer,
        name: attachment.name || attachment.file_name || attachment.filename,
        mimeType: attachment.mime_type || attachment.mimeType || attachment.content_type,
        pointerType: attachment.file_kind || attachment.type,
        conversationId: attachment.conversation_id || attachment.conversationId ||
          attachmentContext.conversationId || messageContext.conversationId,
        checkContextScopesForConversationId:
          attachment.check_context_scopes_for_conversation_id ||
          attachment.checkContextScopesForConversationId ||
          attachmentContext.checkContextScopesForConversationId ||
          messageContext.checkContextScopesForConversationId,
        gizmoId: attachment.gizmo_id || attachment.gizmoId ||
          attachmentContext.gizmoId || messageContext.gizmoId,
        postId: attachment.post_id || attachment.postId ||
          attachmentContext.postId || messageContext.postId,
        libraryFileId: attachment.library_file_id || attachment.libraryFileId ||
          attachmentContext.libraryFileId || messageContext.libraryFileId,
        mountedLibraryFileId:
          attachment.mounted_library_file_id || attachment.mountedLibraryFileId ||
          attachmentContext.mountedLibraryFileId || messageContext.mountedLibraryFileId,
        libraryDownloadId:
          attachment.library_download_id || attachment.libraryDownloadId ||
          attachmentContext.libraryDownloadId || messageContext.libraryDownloadId,
        sharedLibraryFileId:
          attachment.shared_library_file_id || attachment.sharedLibraryFileId ||
          attachmentContext.sharedLibraryFileId || messageContext.sharedLibraryFileId,
      });
    }

    const content = message.content;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const pointerType = part.content_type || part.type || "";
      const pointers = nestedAssetPointers(part);
      const nestedUrls = nestedAssetUrls(part);
      const partContext = nestedAttachmentContext(part);
      const looksLikeAssetPart = /(?:asset_pointer|file|attachment)/i.test(pointerType);
      const directPartUrl = part.download_url || part.url || part.preview_url ||
        part.image_url && (part.image_url.url || part.image_url) ||
        part.source && (part.source.url || part.source) || part.payload || nestedUrls[0];
      if (!pointers.length && !looksLikeAssetPart && !directAssetUrl(directPartUrl)) continue;

      if (!pointers.length) {
        addOrMerge({
          fileId: part.file_id || part.fileId || part.id,
          url: directPartUrl,
          name: part.name || part.file_name || part.filename,
          mimeType: part.mime_type || part.mimeType,
          pointerType,
          conversationId: part.conversation_id || part.conversationId ||
            partContext.conversationId || messageContext.conversationId,
          checkContextScopesForConversationId:
            part.check_context_scopes_for_conversation_id ||
            part.checkContextScopesForConversationId ||
            partContext.checkContextScopesForConversationId ||
            messageContext.checkContextScopesForConversationId,
          gizmoId: part.gizmo_id || part.gizmoId ||
            partContext.gizmoId || messageContext.gizmoId,
          postId: part.post_id || part.postId ||
            partContext.postId || messageContext.postId,
          libraryFileId: part.library_file_id || part.libraryFileId ||
            partContext.libraryFileId || messageContext.libraryFileId,
          mountedLibraryFileId:
            part.mounted_library_file_id || part.mountedLibraryFileId ||
            partContext.mountedLibraryFileId || messageContext.mountedLibraryFileId,
          libraryDownloadId: part.library_download_id || part.libraryDownloadId,
          sharedLibraryFileId:
            part.shared_library_file_id || part.sharedLibraryFileId ||
            partContext.sharedLibraryFileId || messageContext.sharedLibraryFileId,
        });
        continue;
      }

      pointers.forEach((pointer, pointerIndex) => {
        addOrMerge({
          fileId: pointer.value,
          url: directAssetUrl(pointer.value) || nestedUrls[pointerIndex] ||
            (pointerIndex === 0 ? directPartUrl : null),
          name: part.name || part.file_name || part.filename,
          mimeType: part.mime_type || part.mimeType,
          pointerType: pointerTypeHint(pointerType, pointer.path),
          conversationId: part.conversation_id || part.conversationId ||
            partContext.conversationId || messageContext.conversationId,
          checkContextScopesForConversationId:
            part.check_context_scopes_for_conversation_id ||
            part.checkContextScopesForConversationId ||
            partContext.checkContextScopesForConversationId ||
            messageContext.checkContextScopesForConversationId,
          gizmoId: part.gizmo_id || part.gizmoId ||
            partContext.gizmoId || messageContext.gizmoId,
          postId: part.post_id || part.postId ||
            partContext.postId || messageContext.postId,
          libraryFileId: part.library_file_id || part.libraryFileId ||
            partContext.libraryFileId || messageContext.libraryFileId,
          mountedLibraryFileId:
            part.mounted_library_file_id || part.mountedLibraryFileId ||
            partContext.mountedLibraryFileId || messageContext.mountedLibraryFileId,
          libraryDownloadId: part.library_download_id || part.libraryDownloadId ||
            partContext.libraryDownloadId || messageContext.libraryDownloadId,
          sharedLibraryFileId:
            part.shared_library_file_id || part.sharedLibraryFileId ||
            partContext.sharedLibraryFileId || messageContext.sharedLibraryFileId,
        });
      });
    }

    return descriptors;
  }

  function mergeAttachmentLists(...lists) {
    const merged = [];
    const indexes = new Map();
    for (const list of lists) {
      for (const attachment of list || []) {
        if (!attachment) continue;
        const identity = attachment.fileId
          ? "file:" + attachment.fileId
          : attachment.url
            ? "url:" + attachment.url
            : "name:" + (attachment.name || "") + ":" + merged.length;
        const existingIndex = indexes.get(identity);
        if (existingIndex === undefined) {
          indexes.set(identity, merged.length);
          merged.push({ ...attachment });
          continue;
        }
        const existing = merged[existingIndex];
        for (const [key, value] of Object.entries(attachment)) {
          if ((existing[key] == null || existing[key] === "") && value != null && value !== "") {
            existing[key] = value;
          }
        }
        existing.kind = attachmentKind(
          existing.mimeType,
          existing.pointerType
        );
      }
    }
    return merged;
  }

  function contentText(message) {
    const content = message && message.content;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    const text = [];

    for (const part of parts) {
      if (typeof part === "string") {
        if (part.trim()) text.push(part.trim());
        continue;
      }
      if (!part || typeof part !== "object") continue;

      if (typeof part.text === "string" && part.text.trim()) {
        text.push(part.text.trim());
      } else if (part.content_type === "image_asset_pointer") {
        text.push("*Image attached*");
      }
    }

    // Some message variants store their prose directly on content.text.
    if (!text.length && content && typeof content.text === "string" && content.text.trim()) {
      text.push(content.text.trim());
    }

    const attachments = message && message.metadata && Array.isArray(message.metadata.attachments)
      ? message.metadata.attachments
      : [];
    for (const attachment of attachments) {
      const name = attachment && (attachment.name || attachment.file_name);
      if (name) text.unshift(`*Attached: ${name}*`);
    }

    return text.join("\n\n").trim();
  }

  function isVisibleConversationMessage(message) {
    if (!message || !message.author) return false;
    const role = message.author.role;
    if (role !== "user" && role !== "assistant") return false;

    const metadata = message.metadata || {};
    if (
      metadata.is_visually_hidden_from_conversation ||
      metadata.is_user_system_message ||
      metadata.is_system_message
    ) return false;

    // Assistant messages addressed to a tool are internal agent steps. The
    // visible reply is addressed to "all" (or has no recipient field).
    if (role === "assistant" && message.recipient && message.recipient !== "all") return false;
    return true;
  }

  function activeMessages(conversation) {
    if (!conversation || !conversation.mapping || !conversation.current_node) return [];

    const page = conversation.__paginatedConversationPage;
    if (
      conversation.has_more === true ||
      (page && (page.cursor != null || page.has_more === true || page.hasMore === true))
    ) {
      throw new Error("conversation response still has older paginated messages");
    }

    const mapping = conversation.mapping;
    const reverseNodes = [];
    const visited = new Set();
    let nodeId = conversation.current_node;

    // Follow parents from current_node. Walking mapping values in insertion
    // order would export abandoned edits and alternate regenerations too.
    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = mapping[nodeId];
      reverseNodes.push({ node, nodeId });

      nodeId = node.parent;
    }

    if (nodeId && !mapping[nodeId]) {
      throw new Error(
        "conversation response is paginated before the root; missing parent node " + nodeId
      );
    }
    if (nodeId && visited.has(nodeId)) {
      throw new Error("conversation graph contains a parent cycle at node " + nodeId);
    }

    const visibleChain = [];
    let pendingHiddenAttachments = [];
    for (const { node, nodeId: currentNodeId } of reverseNodes.reverse()) {
      const message = node && node.message;
      const attachments = messageAttachments(message);
      if (!isVisibleConversationMessage(message)) {
        pendingHiddenAttachments = mergeAttachmentLists(
          pendingHiddenAttachments,
          attachments
        );
        continue;
      }

      const text = contentText(message);
      const role = message.author.role === "user" ? "## You" : "## ChatGPT";
      let visibleAttachments = attachments;
      if (pendingHiddenAttachments.length) {
        if (role === "## ChatGPT" || !visibleChain.length) {
          visibleAttachments = mergeAttachmentLists(
            pendingHiddenAttachments,
            visibleAttachments
          );
        } else {
          const previous = visibleChain[visibleChain.length - 1];
          previous.attachments = mergeAttachmentLists(
            previous.attachments,
            pendingHiddenAttachments
          );
        }
        pendingHiddenAttachments = [];
      }

      if (text || visibleAttachments.length) {
        visibleChain.push({
          id: message.id || node.id || currentNodeId,
          role,
          text,
          attachments: visibleAttachments,
        });
      }
    }

    if (pendingHiddenAttachments.length && visibleChain.length) {
      const previous = visibleChain[visibleChain.length - 1];
      previous.attachments = mergeAttachmentLists(
        previous.attachments,
        pendingHiddenAttachments
      );
    }

    return visibleChain;
  }

  const DEFAULT_PAGE_TURNS = 20;

  function normalizedPageTurns(value) {
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_PAGE_TURNS;
  }

  function conversationEndpoints(conversationId, options = {}) {
    const id = encodeURIComponent(conversationId || "");
    const numTurns = normalizedPageTurns(options.numTurns);
    return [
      "/backend-api/conversations/" + id +
        "?include_has_versions=true&num_turns=" + numTurns,
      "/backend-api/conversation/" + id,
    ];
  }

  function olderMessagesEndpoint(conversationId, cursor, numTurns) {
    const id = encodeURIComponent(conversationId || "");
    return "/backend-api/conversations/" + id + "/messages?before=" +
      encodeURIComponent(String(cursor)) +
      "&include_has_versions=true&num_turns=" + normalizedPageTurns(numTurns);
  }

  function previousPageCursor(body, endpoint) {
    const pageInfo = body && body.page_info;
    if (!pageInfo || pageInfo.has_previous_page !== true) return null;

    const cursor = pageInfo.start_cursor;
    if (
      (typeof cursor !== "string" && typeof cursor !== "number") ||
      String(cursor).length === 0
    ) {
      throw new Error(endpoint + " says older messages exist but returned no start_cursor");
    }
    return String(cursor);
  }

  function conversationFromPaginatedMessages(conversationId, initialPage, pagesNewestFirst) {
    const chronological = [];
    const indexesById = new Map();
    let overlappingMessages = 0;

    // ChatGPT returns messages oldest-to-newest inside each page, while pages
    // themselves are fetched newest-to-oldest. Reverse only the page order.
    // Its own client also tolerates a boundary message appearing in both the
    // older and newer page. Prefer the copy from the newer page because that
    // is the page closest to the active leaf and can contain fresher metadata.
    for (const page of [...pagesNewestFirst].reverse()) {
      for (const message of page) {
        const id = message && message.id;
        if (typeof id !== "string" || !id) {
          throw new Error("paginated ChatGPT history returned a message without an id");
        }
        const existingIndex = indexesById.get(id);
        if (existingIndex !== undefined) {
          chronological[existingIndex] = message;
          overlappingMessages++;
          continue;
        }
        indexesById.set(id, chronological.length);
        chronological.push(message);
      }
    }

    const rootId = "paginated-root:" + conversationId;
    if (indexesById.has(rootId)) {
      throw new Error("paginated ChatGPT history collided with its synthetic root id");
    }

    const mapping = {
      [rootId]: { id: rootId, parent: null, children: [], message: null },
    };
    let parentId = rootId;
    for (const message of chronological) {
      mapping[message.id] = {
        id: message.id,
        parent: parentId,
        children: [],
        message,
      };
      mapping[parentId].children = [message.id];
      parentId = message.id;
    }

    const serverCurrentNode = initialPage && initialPage.current_node;
    const hasServerCurrentNode = typeof serverCurrentNode === "string" &&
      !!mapping[serverCurrentNode];
    // ChatGPT's current web client deliberately uses the newest returned
    // message when the server's current_node is absent from the paginated
    // message set. Hidden tool leaves and long conversations can legitimately
    // produce that shape, so rejecting it makes an otherwise complete export
    // fail. Pagination still has to reach the root before this fallback is
    // allowed.
    const currentNode = chronological.length
      ? (hasServerCurrentNode ? serverCurrentNode : parentId)
      : rootId;

    return {
      ...(initialPage || {}),
      current_node: currentNode,
      has_more: false,
      mapping,
      __paginatedConversationPage: {
        cursor: null,
        has_more: false,
        overlappingMessages,
        usedCurrentNodeFallback: chronological.length > 0 && !hasServerCurrentNode,
      },
    };
  }

  async function responseErrorDetail(response) {
    if (!response || typeof response.json !== "function") return "";
    try {
      const body = await response.json();
      const detail = body && body.detail;
      const candidates = [
        body && body.code,
        body && body.message,
        body && body.error && body.error.code,
        body && body.error && body.error.message,
        detail && typeof detail === "object" && detail.code,
        detail && typeof detail === "object" && detail.message,
        typeof detail === "string" && detail,
      ];
      const values = Array.from(new Set(candidates
        .filter(value => typeof value === "string" && value.trim())
        .map(value => value.trim().replace(/\s+/g, " ").slice(0, 240))));
      return values.length ? " (" + values.join(": ") + ")" : "";
    } catch (error) {
      return "";
    }
  }

  async function fetchJson(fetchImpl, endpoint, options) {
    const response = await fetchImpl(endpoint, {
      credentials: "include",
      headers: { Accept: "application/json", ...(options.headers || {}) },
      signal: options.signal,
    });
    if (!response.ok) {
      const detail = await responseErrorDetail(response);
      throw new Error(endpoint + " returned HTTP " + response.status + detail);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(endpoint + " returned invalid JSON");
    }
  }

  async function fetchPaginatedConversation(conversationId, options) {
    const fetchImpl = options.fetchImpl;
    const numTurns = normalizedPageTurns(options.numTurns);
    const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
      ? options.maxPages
      : Infinity;
    const initialEndpoint = conversationEndpoints(conversationId, { numTurns })[0];
    const initialPage = await fetchJson(fetchImpl, initialEndpoint, options);
    if (!initialPage || !Array.isArray(initialPage.messages)) {
      throw new Error(initialEndpoint + " returned no messages array");
    }

    const pagesNewestFirst = [initialPage.messages];
    let cursor = previousPageCursor(initialPage, initialEndpoint);
    const seenCursors = new Set();

    while (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new Error("paginated ChatGPT history repeated cursor " + cursor);
      }
      seenCursors.add(cursor);
      if (pagesNewestFirst.length >= maxPages) {
        throw new Error(
          "paginated ChatGPT history exceeded the " + maxPages +
          " page safety limit before reaching the root"
        );
      }

      const endpoint = olderMessagesEndpoint(conversationId, cursor, numTurns);
      const page = await fetchJson(fetchImpl, endpoint, options);
      if (!page || !Array.isArray(page.messages)) {
        throw new Error(endpoint + " returned no messages array");
      }
      pagesNewestFirst.push(page.messages);
      cursor = previousPageCursor(page, endpoint);
    }

    return {
      conversation: conversationFromPaginatedMessages(
        conversationId,
        initialPage,
        pagesNewestFirst
      ),
      endpoint: initialEndpoint,
      pages: pagesNewestFirst.length,
    };
  }

  async function fetchActiveMessages(conversationId, options = {}) {
    const fetchImpl = options.fetchImpl || root.fetch;
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

    const errors = [];
    const requestOptions = { ...options, fetchImpl };

    try {
      const result = await fetchPaginatedConversation(conversationId, requestOptions);
      const messages = activeMessages(result.conversation);
      if (!messages.length) throw new Error(result.endpoint + " returned an empty active chain");
      return {
        endpoint: result.endpoint,
        messages,
        pages: result.pages,
        source: "paginated",
        gizmoId: result.conversation && result.conversation.gizmo_id || null,
        projectId:
          result.conversation && result.conversation.project_id ||
          result.conversation && String(result.conversation.gizmo_id || "").startsWith("g-p-") &&
            result.conversation.gizmo_id ||
          null,
        ownerUserId:
          result.conversation && result.conversation.owner &&
          result.conversation.owner.user_id || null,
        overlappingMessages:
          result.conversation.__paginatedConversationPage.overlappingMessages || 0,
        usedCurrentNodeFallback:
          result.conversation.__paginatedConversationPage.usedCurrentNodeFallback === true,
      };
    } catch (error) {
      if (options.signal && options.signal.aborted) throw error;
      errors.push(
        "current paginated web API: " + String(error && error.message || error)
      );
    }

    // ChatGPT's own frontend keeps this singular, non-privileged route as its
    // fallback when paginated history is disabled. It may return a complete
    // mapping. activeMessages rejects it if the root is missing.
    const legacyEndpoint = conversationEndpoints(conversationId, options)[1];
    try {
      const conversation = await fetchJson(fetchImpl, legacyEndpoint, requestOptions);
      const messages = activeMessages(conversation);
      if (!messages.length) throw new Error(legacyEndpoint + " returned an empty active chain");
      return {
        endpoint: legacyEndpoint,
        messages,
        pages: 1,
        source: "complete-mapping-fallback",
        gizmoId: conversation && conversation.gizmo_id || null,
        projectId:
          conversation && conversation.project_id ||
          conversation && String(conversation.gizmo_id || "").startsWith("g-p-") &&
            conversation.gizmo_id ||
          null,
        ownerUserId:
          conversation && conversation.owner && conversation.owner.user_id || null,
        overlappingMessages: 0,
        usedCurrentNodeFallback: false,
      };
    } catch (error) {
      if (options.signal && options.signal.aborted) throw error;
      errors.push(
        "complete mapping fallback: " + String(error && error.message || error)
      );
    }

    throw new Error(errors.join("; ") || "no ChatGPT conversation endpoint succeeded");
  }

  function collapseAndValidateDomMessages(messages) {
    const collapsed = [];
    for (const message of messages || []) {
      const previous = collapsed[collapsed.length - 1];
      if (previous && previous.ord === message.ord && previous.role === message.role) {
        if (previous.text !== message.text) {
          previous.text += "\n\n" + message.text;
        }
      } else {
        collapsed.push({ ...message });
      }
    }

    for (let i = 1; i < collapsed.length; i++) {
      if (collapsed[i - 1].role === collapsed[i].role) {
        throw new Error(
          `ChatGPT page scan detected a missing turn between positions ${i} and ${i + 1}. ` +
          "No file was created. Reload that conversation and retry."
        );
      }
    }
    return collapsed;
  }

  root.ChatGPTConversationGraph = {
    accountHeader,
    activeMessages,
    collapseAndValidateDomMessages,
    conversationEndpoints,
    conversationFromPaginatedMessages,
    contentText,
    cleanAssetId,
    canonicalAssetPointer,
    currentFileResolverImport,
    effectiveGizmoIdFromFileInfo,
    fileDownloadEndpoint,
    fileDownloadReference,
    fileInfoEndpoint,
    fileRequestHeaders,
    fetchActiveMessages,
    integrityObservationHeader,
    messageAttachments,
    mergeAttachmentLists,
    olderMessagesEndpoint,
    projectIdFromPath,
    renderedMediaFileIds,
  };
})(globalThis);
