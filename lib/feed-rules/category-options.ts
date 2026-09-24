// The shop's categories as the rule builder lists them: id and full trail, in
// trail order, so "Accessories" under Chairs and under Desks are tellable
// apart. Pure.
export type CategoryOption = { id: string; path: string }

export function categoryOptions(categories: ReadonlyArray<{ id: string; name: string; parentId: string | null }>): CategoryOption[] {
  const byId = new Map(categories.map((category) => [category.id, category]))
  const options = categories.map((category) => {
    const names: string[] = []
    let current: { id: string; name: string; parentId: string | null } | undefined = category
    // Hop limit: a loop in the parent ids must not hang the page.
    for (let hops = 0; current && hops < 20; hops++) {
      names.unshift(current.name)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return { id: category.id, path: names.join(' > ') }
  })
  return options.sort((a, b) => a.path.localeCompare(b.path))
}
