import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Result,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, CloudUploadOutlined, CopyOutlined, DeleteOutlined, EditOutlined, SyncOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { projectApi, credentialApi, serverApi, userApi } from '../api';
import { useMe } from '../auth';
import { PageHeader } from '../components/AppLayout';
import { ProjectForm } from '../components/ProjectForm';
import { CopyProjectModal } from '../components/CopyProjectModal';
import { BuildTriggerModal } from '../components/BuildTriggerModal';
import { BuildsTable } from '../components/BuildsTable';
import { formatTime } from '../format';
import type { TargetInfo } from '../types';

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = Number(params.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message, modal } = AntdApp.useApp();
  const { data: meData } = useMe();
  const isAdmin = meData?.user.role === 'admin';

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectApi.get(projectId),
    enabled: Number.isFinite(projectId),
    refetchInterval: 10_000,
  });

  const credentialsQuery = useQuery({
    queryKey: ['credentials'],
    queryFn: credentialApi.list,
    enabled: isAdmin,
  });
  const serversQuery = useQuery({ queryKey: ['servers'], queryFn: serverApi.list, enabled: isAdmin });
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: userApi.list, enabled: isAdmin });

  const [formOpen, setFormOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<number[]>([]);
  const [savingMembers, setSavingMembers] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const project = projectQuery.data?.project;

  useEffect(() => {
    if (project) setSelectedMembers(project.members.map((member) => member.id));
  }, [project]);

  const memberOptions = useMemo(
    () =>
      (usersQuery.data?.users ?? [])
        .filter((user) => user.role === 'member')
        .map((user) => ({ value: user.id, label: `${user.displayName || user.username}（${user.username}）` })),
    [usersQuery.data],
  );

  if (projectQuery.isLoading) {
    return (
      <div style={{ padding: 80, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!project) {
    return (
      <Result
        status="404"
        title="项目不存在"
        subTitle={projectQuery.error instanceof Error ? projectQuery.error.message : '项目可能已被删除或没有访问权限'}
        extra={<Button onClick={() => navigate('/projects')}>返回项目列表</Button>}
      />
    );
  }

  const refreshProject = () => {
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const saveMembers = async () => {
    setSavingMembers(true);
    try {
      await projectApi.updateMembers(projectId, selectedMembers);
      message.success('成员权限已保存');
      refreshProject();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSavingMembers(false);
    }
  };

  const verifyRepo = async () => {
    setVerifying(true);
    try {
      const result = await projectApi.verifyRepo(projectId);
      message.success(`仓库连接正常，共 ${result.branchCount} 个分支（${result.elapsedMs}ms）`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '仓库连接失败');
    } finally {
      setVerifying(false);
    }
  };

  const removeProject = () => {
    modal.confirm({
      title: `删除项目「${project.name}」？`,
      content: '项目的发布记录、日志与工作区将一并删除，且无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await projectApi.remove(projectId);
          message.success('项目已删除');
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          navigate('/projects', { replace: true });
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const targetColumns: ColumnsType<TargetInfo> = [
    {
      title: '服务器',
      key: 'server',
      width: 220,
      render: (_, target) => (
        <div>
          <div style={{ fontWeight: 500 }}>{target.serverName}</div>
          <div className="mj-muted mj-mono" style={{ fontSize: 12 }}>
            {target.username}@{target.host}:{target.port}
          </div>
        </div>
      ),
    },
    {
      title: '远程目录',
      dataIndex: 'remoteDir',
      width: 220,
      render: (value: string) => <span className="mj-mono">{value}</span>,
    },
    {
      title: '上传后命令',
      dataIndex: 'deployCommands',
      render: (value: string) =>
        value ? <pre className="mj-target-command">{value}</pre> : <span className="mj-muted">无</span>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 80,
      render: (value: boolean) => (value ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
  ];

  const overview = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card className="mj-card" style={{ marginTop: 0 }}>
        <Descriptions column={{ xs: 1, sm: 2 }} size="middle">
          <Descriptions.Item label="仓库">
            <span className="mj-mono">{project.repoUrl}</span>
          </Descriptions.Item>
          <Descriptions.Item label="Git 凭据">{project.credentialName || <span className="mj-muted">公开仓库</span>}</Descriptions.Item>
          <Descriptions.Item label="默认分支">
            <Tag className="mj-mono">{project.defaultBranch}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="产物路径">
            <span className="mj-mono">{project.artifactPath}</span>
          </Descriptions.Item>
          <Descriptions.Item label="目标运行时">
            {project.targetRuntime ? (
              <Tag className="mj-mono">{project.targetRuntime}</Tag>
            ) : (
              <span className="mj-muted">未指定</span>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="构建">
            {project.buildEnabled ? (
              <span>
                启用 · 超时 {project.buildTimeoutSec}s
                {project.buildCommand ? (
                  <pre className="mj-target-command" style={{ marginTop: 6 }}>
                    {project.buildCommand}
                  </pre>
                ) : null}
              </span>
            ) : (
              <span className="mj-muted">不执行构建，直接同步产物</span>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="发布策略">
            {project.onTargetFailure === 'abort' ? '任一目标失败立即中止' : '单台失败后继续其余目标'}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">{formatTime(project.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{formatTime(project.updatedAt)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title={`发布目标（${project.targets.length}）`} styles={{ body: { padding: 0 } }}>
        <Table<TargetInfo>
          rowKey="id"
          columns={targetColumns}
          dataSource={project.targets}
          pagination={false}
          size="middle"
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置发布目标" /> }}
        />
      </Card>

      <Card title="最近发布" styles={{ body: { padding: 0 } }}>
        <BuildsTable projectId={projectId} />
      </Card>
    </Space>
  );

  const members = (
    <Card>
      <Typography.Paragraph type="secondary">
        普通成员只能查看并发布被授权的项目。管理员默认拥有全部项目权限。
      </Typography.Paragraph>
      <Space direction="vertical" size={12} style={{ width: '100%', maxWidth: 520 }}>
        <Select
          mode="multiple"
          allowClear
          placeholder="选择可访问该项目的成员"
          options={memberOptions}
          value={selectedMembers}
          onChange={setSelectedMembers}
          loading={usersQuery.isLoading}
        />
        <Button type="primary" onClick={() => void saveMembers()} loading={savingMembers}>
          保存成员权限
        </Button>
      </Space>
    </Card>
  );

  return (
    <div>
      <Space size={4} style={{ marginBottom: 8 }}>
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate('/projects')}>
          返回项目列表
        </Button>
      </Space>
      <PageHeader
        title={project.name}
        subtitle={project.description || `默认分支 ${project.defaultBranch}`}
        extra={
          <>
            <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setTriggerOpen(true)}>
              立即发布
            </Button>
            {isAdmin ? (
              <>
                <Button icon={<SyncOutlined />} loading={verifying} onClick={() => void verifyRepo()}>
                  测试仓库
                </Button>
                <Button icon={<EditOutlined />} onClick={() => setFormOpen(true)}>
                  编辑
                </Button>
                <Button icon={<CopyOutlined />} onClick={() => setCopyOpen(true)}>
                  复制
                </Button>
                <Button danger icon={<DeleteOutlined />} onClick={removeProject}>
                  删除
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <Tabs
        items={[
          { key: 'overview', label: '概览', children: overview },
          {
            key: 'builds',
            label: '发布记录',
            children: (
              <Card styles={{ body: { padding: 0 } }}>
                <BuildsTable projectId={projectId} />
              </Card>
            ),
          },
          ...(isAdmin ? [{ key: 'members', label: '成员', children: members }] : []),
        ]}
      />

      <ProjectForm
        open={formOpen}
        project={project}
        credentials={credentialsQuery.data?.credentials ?? []}
        servers={serversQuery.data?.servers ?? []}
        users={(usersQuery.data?.users ?? []).filter((user) => user.role === 'member' && !user.disabled)}
        onClose={() => setFormOpen(false)}
        onSaved={() => refreshProject()}
      />

      <CopyProjectModal
        open={copyOpen}
        project={{ id: project.id, name: project.name }}
        onClose={() => setCopyOpen(false)}
        onCopied={(copied) => navigate(`/projects/${copied.id}`)}
      />

      <BuildTriggerModal
        open={triggerOpen}
        project={{ id: project.id, name: project.name, defaultBranch: project.defaultBranch }}
        onClose={() => {
          setTriggerOpen(false);
          refreshProject();
        }}
      />
    </div>
  );
}
