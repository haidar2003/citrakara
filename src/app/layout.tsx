// src/app/layout.tsx
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Container } from '@mui/material';
import { Roboto } from 'next/font/google';
import Navbar from '@/components/Navbar';
import AuthDialog from '@/components/AuthDialog'; // will become client if needed
import theme from '@/theme';

const roboto = Roboto({
  weight: ['300', '400', '500', '700'],
  subsets: ['latin'],
  variable: '--font-roboto',
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={roboto.variable}>
      <body>
        <AppRouterCacheProvider options={{ key: 'css' }}>
          <ThemeProvider theme={theme}>
            <CssBaseline />
            <Navbar />
            <Container sx={{ mt: 4 }}>{children}</Container>
            <AuthDialog />
          </ThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
