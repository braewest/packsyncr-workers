/**
 * RESOURCE TYPES:
 * other: A other resource type
 */
const RESOURCE_TYPES = ["other"];

// Resource Rules
const RESOURCE_NAME_MIN_LENGTH = 1;
const RESOURCE_NAME_MAX_LENGTH = 64;
const RESOURCE_DESCRIPTION_MAX_LENGTH = 256;

/**
 * Create the new resource in the packsyncr database.
 */
export async function createResource(env, requester_uuid, type, name, description) {
	const resource_uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds

	// Check rules
	if (type !== undefined && !RESOURCE_TYPES.includes(type)) {
		throw new Error("invalid_resource_type");
	}
  if (name.length < RESOURCE_NAME_MIN_LENGTH || name.length > RESOURCE_NAME_MAX_LENGTH) {
    throw new Error("invalid_name_length");
  }
  if (description !== undefined && description.length > RESOURCE_DESCRIPTION_MAX_LENGTH) {
    throw new Error("invalid_description_length");
  }

	// Create resource
  await env.PACKSYNCR_DB.prepare(`
    INSERT INTO resources (
      resource_uuid,
      owner_uuid,
      type,
      name,
      description,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    resource_uuid,
    requester_uuid,
    type ?? "custom",
    name,
    description ?? null,
    now,
    now // Updated at creation time
  ).run();

	// Update user's resources_created count
  await env.PACKSYNCR_DB.prepare(`
    UPDATE users
    SET resources_created = resources_created + 1
    WHERE uuid = ?
  `).bind(requester_uuid).run();
}

export async function updateResource(env, resource_uuid, requester_uuid, name, description) {
  const now = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds

  // Check rules
  if (name !== undefined && (name.length < RESOURCE_NAME_MIN_LENGTH || name.length > RESOURCE_NAME_MAX_LENGTH)) {
    return new Error("invalid_name_length");
  }
  if (description !== undefined && description.length > RESOURCE_DESCRIPTION_MAX_LENGTH) {
    return new Error("invalid_description_length");
  }

  // Keep list of necessary changes
  const fields = [];
  const values = [];

  if (name !== undefined) {
    fields.push("name = ?");
    values.push(name);
  }
  if (description !== undefined) {
    fields.push("description = ?");
    values.push(description);
  }

  // Update updated_at timestamp
  fields.push("updated_at = ?");
  values.push(now);

  values.push(resource_uuid, requester_uuid);

  // Update resource
  const result = await env.PACKSYNCR_DB.prepare(`
    UPDATE resources
    SET ${fields.join(", ")}
    WHERE resource_uuid = ? AND owner_uuid = ?
  `).bind(...values).run();

  if (result.changes === 0) {
    throw new Error("forbidden_action");
  }
}
