import { expect, test } from 'bun:test'
import { fakeDaemon, useDom } from '../test/dom'

useDom()

interface Row {
  id: number
  title: string
}

async function render(search: Record<string, unknown>, rows: Row[], total = rows.length) {
  const { render: draw } = await import('@testing-library/react/pure')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { ListView } = await import('../../../../dashboard/src/components/list-view')
  const daemon = fakeDaemon({ '/memory/list/memories': { body: { rows, total, page: 1, pageSize: 50, sort: 'age', dir: 'desc' } } })
  globalThis.fetch = daemon.fetch as typeof fetch
  const changes: Record<string, unknown>[] = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = draw(
    <QueryClientProvider client={client}>
      <ListView<Row>
        noun="memories"
        endpoint="/memory/list/memories"
        search={search}
        onSearch={(next) => changes.push(next as Record<string, unknown>)}
        columns={[{ id: 'title', header: 'Memory', sort: 'title', cell: (row) => row.title }, { id: 'age', header: 'Saved', sort: 'age', cell: () => 'today' }]}
        rowId={(row) => row.id}
        defaultSort="age"
        defaultDir="desc"
        empty="No memories yet."
        panel={(id) => ({ title: `Memory ${id}`, body: <p>detail of {id}</p> })}
      />
    </QueryClientProvider>,
  )
  return { screen, changes, daemon }
}

test('rows come from the daemon page by page, with a count a person can read', async () => {
  const { screen, daemon } = await render({}, [{ id: 1, title: 'Bun is pinned' }, { id: 2, title: 'CI reads it' }], 120)
  expect(await screen.findByText('Bun is pinned')).toBeDefined()
  expect(screen.getByText('1 to 50 of 120 memories')).toBeDefined()
  expect(daemon.calls.map((call) => call.path)).toEqual(['/memory/list/memories'])
})

test('a stored title with markup stays text: no element is made from it', async () => {
  const { screen } = await render({}, [{ id: 1, title: '<img src=x onerror="alert(1)">' }])
  expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeDefined()
  expect(document.querySelectorAll('img').length).toBe(0)
})

test('a header sorts on the daemon and starts again at page 1; a second press flips the direction', async () => {
  const { screen, changes } = await render({ page: 3 }, [{ id: 1, title: 'one' }])
  await screen.findByText('one')
  screen.getByRole('button', { name: 'Memory' }).click()
  expect(changes.at(-1)).toEqual({ sort: 'title', dir: 'asc' })
  const sorted = await render({ sort: 'title', dir: 'asc' }, [{ id: 1, title: 'two' }])
  await sorted.screen.findAllByText('two')
  sorted.screen.getAllByRole('button', { name: /Memory/ }).at(-1)!.click()
  expect(sorted.changes.at(-1)).toEqual({ sort: 'title', dir: 'desc' })
})

test('choosing a row opens its panel through the URL; the open row shows its detail', async () => {
  const { screen, changes } = await render({}, [{ id: 7, title: 'seven' }])
  ;(await screen.findByRole('button', { name: 'seven' })).click()
  expect(changes.at(-1)).toEqual({ open: 7 })
  const open = await render({ open: 7 }, [{ id: 7, title: 'seven' }])
  expect(await open.screen.findByText('detail of 7')).toBeDefined()
  expect(open.screen.getByRole('dialog', { name: 'Memory 7' })).toBeDefined()
})

test('an empty list says what happens next', async () => {
  const { screen } = await render({}, [], 0)
  expect(await screen.findByText('No memories yet.')).toBeDefined()
})
