import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { AppLayout } from './components/AppLayout';
import { useMe } from './auth';
import LoginPage from './pages/LoginPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import BuildDetailPage from './pages/BuildDetailPage';
import ServersPage from './pages/ServersPage';
import CredentialsPage from './pages/CredentialsPage';
import UsersPage from './pages/UsersPage';
import AccountPage from './pages/AccountPage';
import NotFoundPage from './pages/NotFoundPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }
  if (!data?.user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

export default function AppRoutes() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="projects/:id/builds/:buildId" element={<BuildDetailPage />} />
          <Route path="servers" element={<ServersPage />} />
          <Route path="credentials" element={<CredentialsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </>
  );
}
