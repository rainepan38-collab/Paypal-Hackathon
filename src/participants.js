/** Resolve names using the authenticated organizer and the actual group's members. */
export function validateParticipants(names, context) {
  if (!Array.isArray(names) || !names.length || names.length > 9) throw new Error('Please name 1–9 other group members.');
  const { organizer, members } = context || {};
  const normalize = name => String(name).trim().toLowerCase();
  const resolved = names.map(name => {
    const value = normalize(name);
    if (/^(me|myself|i)$/.test(value)) throw new Error('Do not list yourself among the people who owe you.');
    if (value === 'you') {
      const jimmy = members?.filter(member => member.username === 'jimmy');
      if (!organizer || organizer.username === 'jimmy' || jimmy?.length !== 1 || members.some(member => normalize(member.display_name) === 'you')) {
        throw new Error('Please clarify who “You” refers to. Use current group member names.');
      }
      return jimmy[0];
    }
    const matches = members?.filter(member => [normalize(member.display_name), normalize(member.username)].includes(value));
    if (members && matches.length !== 1) throw new Error(`Please use names from this group: ${members.map(member => member.display_name).join(', ')}.`);
    if (!members && (!value || value.length > 60)) throw new Error('Please name 1–9 other people (excluding yourself).');
    return matches?.[0] || { id:value, display_name:String(name).trim() };
  });
  if (organizer && resolved.some(member => member.id === organizer.id)) throw new Error('Do not list yourself among the people who owe you.');
  if (new Set(resolved.map(member => member.id)).size !== resolved.length) throw new Error('Each person must be named once.');
  return resolved;
}
