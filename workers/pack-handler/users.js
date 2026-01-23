/** 
 * Removes a pack from a user's follow list.
 */ 
export async function unfollowPack(env, pack_uuid, requester_uuid) {
  // Fetch the collaborator entry
  const collaborator = await env.PACKSYNCR_DB.prepare(`
    SELECT role 
    FROM pack_collaborators 
    WHERE pack_uuid = ? AND user_uuid = ? 
  `).bind(pack_uuid, requester_uuid).first(); 

  if (!collaborator) { 
    throw new Error("not_following_pack"); 
  } 

  // Delete collaborator entry 
  const result = await env.PACKSYNCR_DB.prepare(`
    DELETE FROM pack_collaborators 
    WHERE pack_uuid = ? AND user_uuid = ? 
  `).bind(pack_uuid, requester_uuid).run();
  
  // Decrement the user's follow count
  await env.PACKSYNCR_DB.prepare(`
    UPDATE users
    SET packs_followed = packs_followed - 1
    WHERE uuid = ? AND packs_followed > 0
  `).bind(requester_uuid).run();
}
