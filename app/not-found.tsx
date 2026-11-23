import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="report-page mx-auto max-w-xl px-5 py-10 space-y-4">
      <h1 className="page-title">Page unavailable</h1>
      <p className="text-muted-foreground">
        This page doesn’t exist or isn’t available to your account.
      </p>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 py-2"
      >
        Back to library
      </Link>
    </main>
  )
}
