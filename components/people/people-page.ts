/** Keep server ordering while a later page refreshes a person already shown. */
export function mergePeoplePage<T extends { personId: string }>(
  previous: readonly T[],
  incoming: readonly T[],
): T[] {
  return [
    ...new Map([...previous, ...incoming].map((person) => [person.personId, person])).values(),
  ]
}
