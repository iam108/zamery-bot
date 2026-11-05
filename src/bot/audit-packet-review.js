// Keep this canonical view in sync with packetIdentity in the browser client.
// Contact details and delivery URLs do not change an inspection's source facts.
function packetReviewIdentity(packet) {
  packet ||= {};
  const identity = {};
  for (const key of ['org','address','service','object_category','cad_num','archive_url','zones_info']) identity[key] = String(packet[key] || '').trim();
  identity.video_required = !!(packet.video_required || packet.has_video);
  identity.materials = ['materials','egrn_links'].flatMap(source => (Array.isArray(packet[source]) ? packet[source] : []).map(file => ({
    source, id:String(file.id || ''), role:String(file.role || ''), name:String(file.name || ''), mime:String(file.mime || ''),
    bytes:Number(file.bytes) || 0, sha256:String(file.sha256 || ''),
  }))).sort((a,b) => { const left=JSON.stringify(a), right=JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
  return identity;
}
module.exports = { packetReviewIdentity };
