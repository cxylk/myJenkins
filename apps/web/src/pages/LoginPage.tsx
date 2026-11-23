import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useLogin, useMe } from '../auth';
import { ApiError } from '../api';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data, isLoading } = useMe();
  const login = useLogin();
  const [error, setError] = useState<string | null>(null);

  if (!isLoading && data?.user) return <Navigate to="/projects" replace />;

  const from = (location.state as { from?: string } | null)?.from || '/projects';

  return (
    <div className="mj-login">
      <div className="mj-login-card">
        <div className="mj-login-logo">
          <span className="mj-logo-badge" style={{ width: 34, height: 34 }}>
            M
          </span>
          <span>myJenkins</span>
        </div>
        <div className="mj-login-sub">轻量级 CI/CD 发布系统 · 登录后继续</div>

        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 18 }} closable onClose={() => setError(null)} />
        ) : null}

        <Form
          layout="vertical"
          onFinish={(values: { username: string; password: string }) => {
            setError(null);
            login.mutate(values, {
              onSuccess: () => {
                localStorage.setItem('myjenkins:lastUsername', values.username);
                navigate(from, { replace: true });
              },
              onError: (err) => setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试'),
            });
          }}
          initialValues={{ username: localStorage.getItem('myjenkins:lastUsername') || '' }}
          requiredMark={false}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} size="large" autoComplete="username" placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} size="large" autoComplete="current-password" placeholder="请输入密码" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" size="large" block loading={login.isPending}>
              登录
            </Button>
          </Form.Item>
        </Form>

        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 18, marginBottom: 0 }}>
          首次部署请使用环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 创建的账号；若未设置密码，请查看容器启动日志。
        </Typography.Paragraph>
      </div>
    </div>
  );
}
