import { BRAND_ICONS } from '@/lib/branding.mjs'
import { headers } from 'next/headers'
import { UserActivityTracker } from '@/components/user-activity-tracker'
import { initialAuthState } from '@/lib/identity/auth-state'
import type { Metadata } from 'next'
import type React from 'react'
import { UploadProvider } from '@/components/upload-provider'
import { AppHeader } from '@/components/app-header'
import { ThemeProvider } from '@/components/theme-provider'
import { QueryProvider } from '@/components/query-provider'
import { AuthProvider } from '@/components/auth-provider'
import { APP_TITLE } from '@/lib/constants'
import './globals.css'
import { ProcessingSettings } from '@/components/processing-settings'
import { MapProvider } from '@/components/map-provider'
import { runtimeMapConfig } from '@/lib/travel/map-config-server'
import { flagOn } from '@/lib/flags'

export const metadata: Metadata = {
  title: APP_TITLE,
  description: 'Stillmark — your photos, people, and places, remembered.',
  icons: BRAND_ICONS,
  appleWebApp: { capable: true, title: APP_TITLE, statusBarStyle: 'default' },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const auth = await initialAuthState()
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <html
      lang="en"
      className="dark"
      suppressHydrationWarning
      data-preview-batch={flagOn('PREVIEW_BATCH_ENABLED') ? 'true' : undefined}
    >
      <head>
        <link rel="manifest" href="/site.webmanifest" crossOrigin="use-credentials" />
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');document.documentElement.classList.toggle('dark',t==='system'?matchMedia('(prefers-color-scheme: dark)').matches:t!=='light')}catch(e){document.documentElement.classList.add('dark')}",
          }}
        />
      </head>
      <body className="antialiased">
        <MapProvider config={runtimeMapConfig()}>
          <ThemeProvider>
            <QueryProvider>
              <AuthProvider initialState={auth}>
                <ProcessingSettings automaticSearch={flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')}>
                  <UploadProvider>
                    <AppHeader />
                    <UserActivityTracker />
                    <div className="app-workspace">{children}</div>
                  </UploadProvider>
                </ProcessingSettings>
              </AuthProvider>
            </QueryProvider>
          </ThemeProvider>
        </MapProvider>
      </body>
    </html>
  )
}
