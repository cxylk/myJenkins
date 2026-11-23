import { App as AntdApp, Button, Card, Col, Descriptions, Form, Input, Row, Space, Statistic, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { authApi, systemApi } from '../api';
import { useMe } from '../auth';
import { PageHeader } from '../components/AppLayout';
import { RoleTag } from '../components/StatusTag';
import { formatBytes, uptimeText } from '../format';

export default function AccountPage() {
  const { message } = AntdApp.useApp();
  const { data } = useMe();
  const user = data?.user;
  const [form] = Form.useForm<{ oldPassword: string; newPassword: string; confirmPassword: string }>();
  const infoQuery = useQuery({ queryKey: ['system-info'], queryFn: systemApi.info, refetchInterval: 10_000 });
  const info = infoQuery.data;

  const submit = async (values: { oldPassword: string; newPassword: string }) => {
    try {
      await authApi.changePassword(values.oldPassword, values.newPassword);
      message.success('密码已修改，其他设备上的登录已失效');
      form.resetFields();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '修改失败');
    }
  };

  return (
    <div>
      <PageHeader title="账号设置" subtitle="修改登录密码并查看系统运行信息" />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="修改密码">
            <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="当前用户">
                <Space>
                  <span className="mj-mono">{user?.username}</span>
                  <RoleTag role={user?.role === 'admin' ? 'admin' : 'member'} />
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="显示名">{user?.displayName || '-'}</Descriptions.Item>
            </Descriptions>
            <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 420 }}>
              <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Form.Item
                name="newPassword"
                label="新密码"
                rules={[
                  { required: true, message: '请输入新密码' },
                  { min: 8, message: '至少 8 位' },
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item
                name="confirmPassword"
                label="确认新密码"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: '请再次输入新密码' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                      return Promise.reject(new Error('两次输入的密码不一致'));
                    },
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit">
                保存新密码
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="系统信息" loading={infoQuery.isLoading}>
            {info ? (
              <>
                <div className="mj-stat" style={{ marginBottom: 16 }}>
                  <div className="mj-stat-item">
                    <div className="mj-stat-label">项目</div>
                    <div className="mj-stat-value">{info.counts.projects}</div>
                  </div>
                  <div className="mj-stat-item">
                    <div className="mj-stat-label">今日发布</div>
                    <div className="mj-stat-value">{info.counts.buildsToday}</div>
                  </div>
                  <div className="mj-stat-item">
                    <div className="mj-stat-label">执行中 / 排队</div>
                    <div className="mj-stat-value">
                      {info.queue.active} / {info.queue.queued}
                    </div>
                  </div>
                </div>
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="版本">v{info.version}</Descriptions.Item>
                  <Descriptions.Item label="Node.js">{info.node}</Descriptions.Item>
                  <Descriptions.Item label="运行时长">{uptimeText(info.uptimeSec)}</Descriptions.Item>
                  <Descriptions.Item label="并发上限">{info.queue.maxConcurrency}</Descriptions.Item>
                  <Descriptions.Item label="日志上限">{formatBytes(info.logMaxBytes)}</Descriptions.Item>
                  <Descriptions.Item label="日志保留">{info.logRetentionDays} 天</Descriptions.Item>
                  <Descriptions.Item label="数据目录">
                    <Typography.Text className="mj-mono" style={{ fontSize: 12 }} copyable>
                      {info.dataDir}
                    </Typography.Text>
                  </Descriptions.Item>
                </Descriptions>
              </>
            ) : (
              <Typography.Text type="secondary">加载失败</Typography.Text>
            )}
          </Card>
        </Col>
      </Row>

      <Card className="mj-card" title="关于 myJenkins">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          myJenkins 是一个轻量级发布系统：按项目绑定 Git 仓库与凭据，发布时选择分支，自动完成拉取、构建、产物上传与远程命令执行，
          并把每一步输出实时记录到日志中。v1 仅支持 Linux 目标机（SSH/SFTP），构建在服务所在容器内执行。
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
