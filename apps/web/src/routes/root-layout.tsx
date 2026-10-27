import { Link, Outlet } from 'react-router';
import { UserMenu } from '@/components/user-menu';
import { useCurrentUser } from '@/lib/auth';

export function RootLayout() {
  const user = useCurrentUser();

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6 font-semibold">
          <div className="flex items-center gap-6">
            <Link to="/">ERP Workshop</Link>
            <nav className="flex items-center gap-4 text-sm font-normal">
              {/* Stock is visible to every signed-in role; the API scopes store employees. */}
              <Link to="/inventory" className="text-muted-foreground hover:text-foreground">
                สต็อก
              </Link>
              {/* Manager-only stock adjustments and audit trail (@Roles('MANAGER')). */}
              {user?.role === 'MANAGER' && (
                <Link to="/adjustments" className="text-muted-foreground hover:text-foreground">
                  ปรับสต็อก
                </Link>
              )}
              {/* Administrator-only master data. The API still enforces @Roles('ADMINISTRATOR'). */}
              {user?.role === 'ADMINISTRATOR' && (
                <>
                  <Link to="/stores" className="text-muted-foreground hover:text-foreground">
                    สาขา
                  </Link>
                  <Link to="/suppliers" className="text-muted-foreground hover:text-foreground">
                    ผู้ขาย
                  </Link>
                  <Link to="/products" className="text-muted-foreground hover:text-foreground">
                    สินค้า
                  </Link>
                </>
              )}
            </nav>
          </div>
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
