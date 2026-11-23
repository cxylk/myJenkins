import { useMemo } from 'react';
import { Avatar, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import {
  CloudServerOutlined,
  KeyOutlined,
  LogoutOutlined,
  ProjectOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLogout, useMe } from '../auth';
import { RoleTag } from './StatusTag';

const { Sider, Header, Content } = Layout;

const TITLES: Array<{ prefix: string; title: string }> = [
  { prefix: '/projects', title: '项目' },
  { prefix: '/servers', title: '服务器' },
  { prefix: '/credentials', title: 'Git 凭据' },
  { prefix: '/users', title: '用户管理' },
  { prefix: '/account', title: '账号设置' },
];

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data } = useMe();
  const logout = useLogout();
  const user = data?.user;
  const isAdmin = user?.role === 'admin';

  const selectedKey = useMemo(() => {
    const key = ['/projects', '/servers', '/credentials', '/users', '/account'].find(
      (item) => location.pathname === item || location.pathname.startsWith(`${item}/`),
    );
    return key ?? '/projects';
  }, [location.pathname]);

  const pageTitle = TITLES.find((item) => location.pathname.startsWith(item.prefix))?.title ?? 'myJenkins';

  const items = [
    { key: '/projects', icon: <ProjectOutlined />, label: '项目' },
    { key: '/servers', icon: <CloudServerOutlined />, label: '服务器' },
    { key: '/credentials', icon: <KeyOutlined />, label: 'Git 凭据' },
    ...(isAdmin ? [{ key: '/users', icon: <TeamOutlined />, label: '用户管理' }] : []),
    { key: '/account', icon: <SettingOutlined />, label: '账号设置' },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        className="mj-sider"
        width={208}
        breakpoint="lg"
        collapsedWidth={64}
        collapsible
        theme="dark"
        style={{ background: '#101828' }}
      >
        <div className="mj-logo">
          <span className="mj-logo-badge">M</span>
          <span>myJenkins</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          onClick={({ key }) => navigate(key)}
          style={{ background: 'transparent' }}
        />
      </Sider>
      <Layout>
        <Header className="mj-header" style={{ height: 60, lineHeight: '60px' }}>
          <span className="mj-header-title">{pageTitle}</span>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'account', icon: <UserOutlined />, label: '账号设置' },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'logout') {
                  logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });
                } else if (key === 'account') {
                  navigate('/account');
                }
              },
            }}
          >
            <Space style={{ cursor: 'pointer' }}>
              <Avatar size={30} style={{ background: '#1677ff' }}>
                {(user?.displayName || user?.username || '?').slice(0, 1).toUpperCase()}
              </Avatar>
              <span style={{ fontWeight: 500 }}>{user?.displayName || user?.username}</span>
              <RoleTag role={user?.role === 'admin' ? 'admin' : 'member'} />
            </Space>
          </Dropdown>
        </Header>
        <Content className="mj-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

export function PageHeader(props: { title: string; subtitle?: string; extra?: React.ReactNode }) {
  return (
    <div className="mj-page-header">
      <div>
        <h1 className="mj-page-title">{props.title}</h1>
        {props.subtitle ? <div className="mj-page-subtitle">{props.subtitle}</div> : null}
      </div>
      {props.extra ? <Space wrap>{props.extra}</Space> : null}
    </div>
  );
}

export function EmptyHint(props: { title: string; description?: string }) {
  return (
    <div style={{ padding: '40px 0', textAlign: 'center' }}>
      <Typography.Title level={4}>{props.title}</Typography.Title>
      <Typography.Text type="secondary">{props.description}</Typography.Text>
    </div>
  );
}
