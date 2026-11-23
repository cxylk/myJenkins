import { useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { userApi } from '../api';
import { PageHeader } from '../components/AppLayout';
import { RoleTag } from '../components/StatusTag';
import { useMe } from '../auth';
import { formatTime } from '../format';
import type { User } from '../types';

interface CreateValues {
  username: string;
  displayName?: string;
  password: string;
  role: 'admin' | 'member';
}

interface EditValues {
  displayName?: string;
  role: 'admin' | 'member';
}

export default function UsersPage() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const { data: meData } = useMe();
  const me = meData?.user;
  const [createForm] = Form.useForm<CreateValues>();
  const [editForm] = Form.useForm<EditValues>();
  const [resetForm] = Form.useForm<{ password: string }>();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [saving, setSaving] = useState(false);

  const usersQuery = useQuery({ queryKey: ['users'], queryFn: userApi.list });
  const users = usersQuery.data?.users ?? [];

  useEffect(() => {
    if (createOpen) {
      createForm.resetFields();
      createForm.setFieldsValue({ role: 'member' });
    }
  }, [createOpen, createForm]);

  useEffect(() => {
    if (editing) {
      editForm.setFieldsValue({ displayName: editing.displayName ?? '', role: editing.role });
    }
  }, [editing, editForm]);

  useEffect(() => {
    if (resetting) resetForm.resetFields();
  }, [resetting, resetForm]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['users'] });

  const create = async (values: CreateValues) => {
    setSaving(true);
    try {
      await userApi.create(values);
      message.success('用户已创建');
      setCreateOpen(false);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const update = async (values: EditValues) => {
    if (!editing) return;
    setSaving(true);
    try {
      await userApi.update(editing.id, values);
      message.success('用户已更新');
      setEditing(null);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleDisabled = async (user: User, disabled: boolean) => {
    try {
      await userApi.update(user.id, { disabled });
      message.success(disabled ? '已禁用该用户' : '已启用该用户');
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const remove = async (user: User) => {
    try {
      await userApi.remove(user.id);
      message.success('用户已删除');
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const resetPassword = async (values: { password: string }) => {
    if (!resetting) return;
    setSaving(true);
    try {
      await userApi.resetPassword(resetting.id, values.password);
      message.success('密码已重置，该用户所有会话已失效');
      setResetting(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重置失败');
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<User> = [
    { title: '用户名', dataIndex: 'username', render: (value: string) => <span className="mj-mono">{value}</span> },
    { title: '显示名', dataIndex: 'displayName', render: (value: string | null) => value || '-' },
    { title: '角色', dataIndex: 'role', width: 100, render: (value: User['role']) => <RoleTag role={value} /> },
    {
      title: '状态',
      dataIndex: 'disabled',
      width: 100,
      render: (value: boolean, record) =>
        value ? <Tag color="red">已禁用</Tag> : record.id === me?.id ? <Tag color="blue">当前账号</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: '授权项目',
      dataIndex: 'projectCount',
      width: 100,
      render: (value: number | undefined) => (value === undefined ? 0 : value),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value?: string) => formatTime(value, 'YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 300,
      render: (_, record) => (
        <Space size={2} wrap>
          <Button type="link" size="small" onClick={() => setEditing(record)}>
            编辑
          </Button>
          <Button type="link" size="small" onClick={() => setResetting(record)}>
            重置密码
          </Button>
          <Button
            type="link"
            size="small"
            disabled={record.id === me?.id}
            onClick={() => void toggleDisabled(record, !record.disabled)}
          >
            {record.disabled ? '启用' : '禁用'}
          </Button>
          <Popconfirm
            title="删除用户？"
            description="该用户的项目授权会一并移除，操作不可恢复"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(record)}
          >
            <Button type="link" size="small" danger disabled={record.id === me?.id}>
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
        title="用户管理"
        subtitle="普通成员需要被加入项目后才能查看与发布；管理员拥有全部权限"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建用户
          </Button>
        }
      />

      <Table<User>
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={usersQuery.isLoading}
        pagination={false}
        scroll={{ x: 1000 }}
      />

      <Modal
        title="新建用户"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={saving}
        okText="创建"
      >
        <Form form={createForm} layout="vertical" onFinish={create}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[A-Za-z0-9_.-]{3,32}$/, message: '3-32 位字母、数字、下划线、点或短横线' },
            ]}
          >
            <Input autoComplete="off" placeholder="zhangsan" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名">
            <Input placeholder="张三" maxLength={50} />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { value: 'member', label: '普通成员（按项目授权）' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editing ? `编辑用户 · ${editing.username}` : '编辑用户'}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={() => editForm.submit()}
        confirmLoading={saving}
        okText="保存"
      >
        <Form form={editForm} layout="vertical" onFinish={update}>
          <Form.Item name="displayName" label="显示名">
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Radio.Group
              disabled={editing?.id === me?.id}
              options={[
                { value: 'member', label: '普通成员' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={resetting ? `重置密码 · ${resetting.username}` : '重置密码'}
        open={Boolean(resetting)}
        onCancel={() => setResetting(null)}
        onOk={() => resetForm.submit()}
        confirmLoading={saving}
        okText="重置"
      >
        <Form form={resetForm} layout="vertical" onFinish={resetPassword}>
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
