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
  const file_directory = await getMultipartField(reader, state, boundary, "file_directory");
  const file_name = await getMultipartField(reader, state, boundary, "file_name");
  const content_type = await getMultipartField(reader, state, boundary, "content_type");
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

    // Get next chunk
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
