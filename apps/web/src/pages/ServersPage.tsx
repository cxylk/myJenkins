import { useEffect, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined } from '@ant-design/icons';
import { serverApi } from '../api';
import { PageHeader } from '../components/AppLayout';
import { formatTime } from '../format';
import type { ServerInfo, TestResult } from '../types';

interface ServerFormValues {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
  secret?: string;
  passphrase?: string;
  clearPassphrase?: boolean;
}

export default function ServersPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ServerFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ServerInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ server: ServerInfo; result: TestResult } | null>(null);
  const [trusting, setTrusting] = useState(false);

  const serversQuery = useQuery({ queryKey: ['servers'], queryFn: serverApi.list });
  const servers = serversQuery.data?.servers ?? [];

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        host: editing.host,
        port: editing.port,
        username: editing.username,
        authType: editing.authType,
        secret: '',
        passphrase: '',
        clearPassphrase: false,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ port: 22, authType: 'password' });
    }
  }, [open, editing, form]);

  const save = async (values: ServerFormValues) => {
    if (!editing && !values.secret?.trim()) {
      message.warning(values.authType === 'password' ? '请输入 SSH 密码' : '请粘贴 SSH 私钥');
      return;
    }
    const payload: Record<string, unknown> = {
      name: values.name,
      host: values.host,
      port: values.port,
      username: values.username,
      authType: values.authType,
    };
    if (values.secret) payload.secret = values.secret;
    if (values.passphrase) payload.passphrase = values.passphrase;
    if (values.clearPassphrase) payload.clearPassphrase = true;

    setSaving(true);
    try {
      if (editing) await serverApi.update(editing.id, payload);
      else await serverApi.create(payload);
      message.success(editing ? '服务器已更新' : '服务器已添加，请测试连接并信任指纹');
      setOpen(false);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const test = async (server: ServerInfo) => {
    setTestingId(server.id);
    try {
      const result = await serverApi.test(server.id);
      setTestResult({ server, result });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const trust = async () => {
    if (!testResult?.result.fingerprint) return;
    setTrusting(true);
    try {
      await serverApi.trust(testResult.server.id, testResult.result.fingerprint);
      message.success('已信任该服务器的主机指纹');
      setTestResult(null);
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '信任失败');
    } finally {
      setTrusting(false);
    }
  };

  const remove = async (server: ServerInfo) => {
    try {
      await serverApi.remove(server.id);
      message.success('服务器已删除');
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const columns: ColumnsType<ServerInfo> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (value: string, record) => (
        <div>
          <div style={{ fontWeight: 500 }}>{value}</div>
          <div className="mj-muted mj-mono" style={{ fontSize: 12 }}>
            {record.username}@{record.host}:{record.port}
          </div>
        </div>
      ),
    },
    {
      title: '认证方式',
      dataIndex: 'authType',
      width: 120,
      render: (value: ServerInfo['authType'], record) => (
        <Space direction="vertical" size={0}>
          <Tag color={value === 'private_key' ? 'blue' : 'default'}>{value === 'private_key' ? 'SSH 私钥' : '密码'}</Tag>
          {record.hasPassphrase ? <span className="mj-muted" style={{ fontSize: 12 }}>含口令</span> : null}
        </Space>
      ),
    },
    {
      title: '主机指纹',
      dataIndex: 'trusted',
      width: 220,
      render: (trusted: boolean, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={trusted ? 'green' : 'orange'}>{trusted ? '已信任' : '未信任'}</Tag>
          {record.fingerprint ? (
            <Tooltip title={record.fingerprint}>
              <span className="mj-mono mj-muted" style={{ fontSize: 11 }}>
                {record.fingerprint.slice(0, 24)}…
              </span>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: '被项目使用',
      dataIndex: 'usedByProjects',
      width: 110,
      render: (value: number) => `${value} 个`,
    },
    {
      title: '添加时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => formatTime(value, 'YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_, record) => (
        <Space size={2} wrap>
          <Button type="link" size="small" loading={testingId === record.id} onClick={() => void test(record)}>
            测试连接
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => {
              setEditing(record);
              setOpen(true);
            }}
          >
            编辑
          </Button>
          <Popconfirm
            title="删除服务器？"
            description="仅未被项目使用的服务器可删除"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(record)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="服务器"
        subtitle="发布会通过 SSH/SFTP 连接这些服务器，首次连接需要信任主机指纹"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            添加服务器
          </Button>
        }
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="主机指纹用于防止中间人攻击"
        description="添加服务器后先点“测试连接”，确认返回的指纹与目标机 /etc/ssh/ssh_host_*_key.pub 一致后再信任。指纹变化时发布会拒绝连接。"
      />

      <Table<ServerInfo>
        rowKey="id"
        columns={columns}
        dataSource={servers}
        loading={serversQuery.isLoading}
        pagination={false}
        scroll={{ x: 900 }}
        locale={{ emptyText: '还没有服务器，先添加一台吧' }}
      />

      <Modal
        title={editing ? `编辑服务器 · ${editing.name}` : '添加服务器'}
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText="保存"
        width={640}
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark="optional">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：生产 Web-01" maxLength={80} />
          </Form.Item>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="host" label="主机地址" rules={[{ required: true, message: '请输入主机地址' }]} style={{ flex: 3 }}>
              <Input placeholder="10.0.0.12 或 app.example.com" />
            </Form.Item>
            <Form.Item name="port" label="端口" rules={[{ required: true }]} style={{ flex: 1, marginLeft: 12 }}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="username" label="登录用户" rules={[{ required: true, message: '请输入登录用户' }]}>
            <Input placeholder="deploy" />
          </Form.Item>
          <Form.Item name="authType" label="认证方式" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { value: 'password', label: '密码' },
                { value: 'private_key', label: 'SSH 私钥' },
              ]}
              optionType="button"
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) => prev.authType !== next.authType}
          >
            {({ getFieldValue }) =>
              getFieldValue('authType') === 'private_key' ? (
                <Form.Item
                  name="secret"
                  label="私钥内容"
                  rules={editing ? [] : [{ required: true, message: '请粘贴私钥' }]}
                  extra={editing ? '留空表示不修改已保存的私钥' : '粘贴完整的 PEM/OpenSSH 私钥'}
                >
                  <Input.TextArea rows={6} className="mj-mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                </Form.Item>
              ) : (
                <Form.Item
                  name="secret"
                  label="登录密码"
                  rules={editing ? [] : [{ required: true, message: '请输入密码' }]}
                  extra={editing ? '留空表示不修改已保存的密码' : undefined}
                >
                  <Input.Password placeholder={editing ? '••••••••' : '请输入 SSH 密码'} autoComplete="new-password" />
                </Form.Item>
              )
            }
          </Form.Item>
          <Form.Item name="passphrase" label="私钥口令" extra="私钥无口令时留空">
            <Input.Password placeholder="如私钥有口令，请填写" autoComplete="new-password" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            密码与私钥会使用 AES-256-GCM 加密保存，接口不会回显明文。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title="连接测试结果"
        open={Boolean(testResult)}
        onCancel={() => setTestResult(null)}
        footer={
          <Space>
            <Button onClick={() => setTestResult(null)}>关闭</Button>
            {testResult?.result.fingerprint &&
            (!testResult.result.trusted || testResult.result.changed) ? (
              <Button type="primary" loading={trusting} onClick={() => void trust()}>
                {testResult.result.changed ? '重新信任新指纹' : '信任并保存指纹'}
              </Button>
            ) : null}
          </Space>
        }
      >
        {testResult ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {testResult.result.ok ? (
              <Alert type="success" showIcon message={`连接成功，耗时 ${testResult.result.elapsedMs}ms`} />
            ) : (
              <Alert type="error" showIcon message="连接失败" description={testResult.result.error} />
            )}
            {testResult.result.changed ? (
              <Alert
                type="warning"
                showIcon
                message="主机指纹已变化"
                description="如果目标机确实重装或更换过密钥，可以重新信任；否则请中止操作并排查。"
              />
            ) : null}
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="服务器">
                {testResult.server.name}（{testResult.server.host}:{testResult.server.port}）
              </Descriptions.Item>
              <Descriptions.Item label="指纹">
                <span className="mj-mono" style={{ wordBreak: 'break-all' }}>
                  {testResult.result.fingerprint || '-'}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="系统信息">{testResult.result.system || '-'}</Descriptions.Item>
            </Descriptions>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
