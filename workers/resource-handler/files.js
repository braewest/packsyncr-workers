/**
 * List of all resource types and what content_types and file_directories are allowed
 */
const RESOURCE_RULES = {
  "hat": { // TODO: Add additive json files
    allowed_content_types: {
      "image/png": {
        allowed_directories: ["textures/item/carved_pumpkin"]
      },
      "application/json": {
        allowed_directories: ["models/item/carved_pumpkin"]
      }
    }
  }
};

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const BUFFER_SIZE = 2 * 1024; // 2 KB

/**
 * Upload a file into a resource.
 */
export async function uploadFile(env, requester_uuid, requestBody, boundary) {
  // Create file reader and buffer
  const reader = requestBody.getReader();
  const state = { buffer: "" }; // Pass buffer by reference

  // Retrieve multipart fields
  const resource_uuid = await getMultipartField(reader, state, boundary, "resource_uuid");
  const content_type = await getMultipartField(reader, state, boundary, "content_type");
  const file_directory = await getMultipartField(reader, state, boundary, "file_directory");
  const file_name = await getMultipartField(reader, state, boundary, "file_name");

  // Fetch resource from database
  const resource = await fetchResource(env, resource_uuid);
  if (!resource) throw new Error("resource_not_found");

  // Check if user owns resource
  if (resource.owner_uuid !== requester_uuid) throw new Error("forbidden_action");

  // Check if content_type and file_directory are valid of resource type
  const rules = RESOURCE_RULES[resource.type];
  if (!rules) throw new Error("undefined_resource_type");
  const contentRules = rules.allowed_content_types[content_type];
  if (!contentRules) throw new Error("forbidden_content_type");
  if (!contentRules.allowed_directories.includes(file_directory)) throw new Error("forbidden_file_directory");

  // Retrieve file if passes validation
  let file;
  try {
    file = await extractAndVerifyFile(reader, state, boundary, "file", content_type);
  } catch (err) {
    throw new Error(err.message);
  }

  return file;
}

/**
 * Fetch resource from database
 */
async function fetchResource(env, resource_uuid) {
  const resource = await env.PACKSYNCR_DB.prepare(`
    SELECT *
    FROM resources
    WHERE resource_uuid = ?
  `).bind(resource_uuid).first();
  return resource;
}

/**
 * Get a field in the multipart upload using the reader and a buffer.
 */
async function getMultipartField(reader, state, boundary, fieldName) {
  const decoder = new TextDecoder();
  const targetHeader = `name="${fieldName}"`;

  let fieldValue;
  while (true) {
    // Search for fieldName part header (check existing buffer)
    const headerIndex = state.buffer.indexOf(targetHeader);
    if (headerIndex !== -1) {
      // After the header, the content starts after two CRLFs
      const afterHeader = state.buffer.slice(headerIndex);
      const match = afterHeader.match(/\r?\n\r?\n/);
      if (match) {
        const contentRest = afterHeader.slice(match.index + match[0].length);
        const boundaryIndex = contentRest.indexOf(boundary);
        if (boundaryIndex !== -1) {
          fieldValue = contentRest.slice(0, boundaryIndex).trim();

          // Remove everything up to the boundary from the buffer
          state.buffer = contentRest.slice(boundaryIndex);
          break;
        }
      }
    }

    // Keep buffer small to avoid large memory usage
    if (state.buffer.length > BUFFER_SIZE) {
      state.buffer = state.buffer.slice(-BUFFER_SIZE);
    }

    // Read next chunk
    const { done, value } = await reader.read();
    if (done) break;

    // Decode chunk to text and append to buffer
    state.buffer += decoder.decode(value, { stream: true });
  }

  if (!fieldValue) {
    throw new Error(`missing_${fieldName}`);
  }

  return fieldValue;
}

/**
 * Extract file from upload and verify it meets the upload requirements
 */
async function extractAndVerifyFile(reader, state, boundary, fieldName, content_type) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const targetHeader = `name="${fieldName}"`;

  let bytesRead = 0;
  let magicBytes = new Uint8Array(0);
  let fileBytes = [];
  let fileStarted = false;

  while (true) {
    // If file is not started, search for header
    let contentRest;
    if (!fileStarted) {
      // Seach for file part header (check existing buffer)
      const headerIndex = state.buffer.indexOf(targetHeader);
      if (headerIndex !== -1) { // header found
        const afterHeader = state.buffer.slice(headerIndex);
        const match = afterHeader.match(/\r?\n\r?\n/);
        if (match) {
          // Retreive file data starting point and start file
          contentRest = afterHeader.slice(match.index + match[0].length);
          fileStarted = true;
        }
      }
    } else {
      contentRest = state.buffer;
    }

    // If file is started, record bytes until boundary or invalid size
    if (fileStarted) {
      // Get chunk bytes and check for boundary
      const boundaryIndex = contentRest.indexOf(boundary);
      let chunkText = contentRest;
      if (boundaryIndex !== -1) {
        chunkText = contentRest.slice(0, boundaryIndex);
      }
      const chunkBytes = encoder.encode(chunkText);

      // Capture magic bytes if needed (first 32 bytes)
      if (magicBytes.length < 32) {
        const needed = 32 - magicBytes.length;
        magicBytes = concatUint8(
          magicBytes,
          chunkBytes.slice(0, needed)
        );
      }

      // Update and check file size
      bytesRead += chunkBytes.length;
      if (bytesRead > MAX_FILE_SIZE) {
        throw new Error("file_too_large");
      }

      // Record bytes
      fileBytes.push(chunkBytes);

      // Remove everything recorded
      state.buffer = contentRest.slice(chunkBytes.length);
    }

    // Keep buffer small to avoid large memory usage
    if (state.buffer.length > BUFFER_SIZE) {
      state.buffer = state.buffer.slice(-BUFFER_SIZE);
    }

    // Read next chunk
    const { done, value } = await reader.read();
    if (done) break;

    // Decode chunk to text and append to buffer
    state.buffer += decoder.decode(value, { stream: true });
  }

  // Check if file was found
  if (!fileStarted) {
    throw new Error(`missing_${fieldName}`);
  }

  // Verify file matches declared content_type
  if (!verifyMagic(content_type, magicBytes)) {
    throw new Error("file_type_mismatch");
  }

  return concatMany(fileBytes);
}

function concatUint8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function concatMany(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function verifyMagic(contentType, bytes) {
  switch (contentType) {
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4E &&
        bytes[3] === 0x47
      );

    case "application/json": {
      const text = new TextDecoder().decode(bytes).trim();
      return text.startsWith("{") || text.startsWith("[");
    }

    default:
      return false;
  }
}
