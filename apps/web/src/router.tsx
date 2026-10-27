import { createBrowserRouter } from 'react-router';
import { RequireAuth } from '@/components/require-auth';
import { AdjustmentsPage } from '@/routes/adjustments';
import { HomePage } from '@/routes/home';
import { InventoryPage } from '@/routes/inventory';
import { LoginPage } from '@/routes/login';
import { ProductsPage } from '@/routes/products';
import { RootLayout } from '@/routes/root-layout';
import { StoresPage } from '@/routes/stores';
import { SuppliersPage } from '@/routes/suppliers';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    // Everything below requires a signed-in user.
    element: <RequireAuth />,
    children: [
      {
        path: '/',
        element: <RootLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'stores', element: <StoresPage /> },
          { path: 'suppliers', element: <SuppliersPage /> },
          { path: 'products', element: <ProductsPage /> },
          { path: 'inventory', element: <InventoryPage /> },
          { path: 'adjustments', element: <AdjustmentsPage /> },
        ],
      },
    ],
  },
]);
