export function legacyIdentityCommand(action: string, p: any): string {
  const id = (x: string) => `"${x}"`
  const lit = (x: string) => "'" + x.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
  const name = id(p.name)
  const simple: Record<string, string> = {
    findUser: `SHOW USERS LIKE ${lit(p.name)}`,
    findRole: `SHOW ROLES LIKE ${lit(p.name)}`,
    userGrants: `SHOW GRANTS TO USER ${name}`,
    roleGrants: `SHOW GRANTS TO ROLE ${name}`,
    restrictUser: `ALTER USER ${name} SET NETWORK_POLICY=PERSONAL_PHOTOS_NO_DIRECT_LOGIN`,
    disableUser: `ALTER USER ${name} SET DISABLED=TRUE`,
    deleteUser: `DROP USER ${name}`,
    setupLink: `ALTER USER ${name} RESET PASSWORD`,
  }
  if (simple[action]) return simple[action]
  if (action === 'createUser')
    return `CREATE USER ${name} TYPE=PERSON NETWORK_POLICY=PERSONAL_PHOTOS_NO_DIRECT_LOGIN COMMENT=${lit('Personal Photos managed access ' + p.marker)}${p.password ? ' PASSWORD=' + lit(p.password) + ' MUST_CHANGE_PASSWORD=FALSE' : ''}`
  if (action === 'createRole')
    return `GRANT ROLE "PERSONAL_PHOTOS_${p.profile.toUpperCase()}" TO ROLE ${name}`
  if (action === 'setPassword')
    return `ALTER USER ${name} SET PASSWORD=${lit(p.password)} MUST_CHANGE_PASSWORD=FALSE`
  if (action === 'setDefaultRole') return `ALTER USER ${name} SET DEFAULT_ROLE=${lit(p.role)}`
  return `${action === 'grantRole' ? 'GRANT' : 'REVOKE'} ROLE ${id(p.role)} ${action === 'grantRole' ? 'TO' : 'FROM'} USER ${name}`
}
