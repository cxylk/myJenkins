import { useState } from 'react';
import { App as AntdApp, Button, Card, Empty, List, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/AppLayout';
import { ProjectForm } from '../components/ProjectForm';
import { BuildTriggerModal } from '../components/BuildTriggerModal';
import { CopyProjectModal } from '../components/CopyProjectModal';
import { BuildStatusTag } from '../components/StatusTag';
import { buildApi, credentialApi, projectApi, serverApi, userApi } from '../api';
import { useMe } from '../auth';
import { formatTime, fromNow } from '../format';
import type { Project, ProjectSummary, RecentBuild } from '../types';

export default function ProjectsPage() {
  const { message, modal } = AntdApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: meData } = useMe();
  const isAdmin = meData?.user.role === 'admin';

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectApi.list,
    refetchInterval: 8000,
  });
  const recentQuery = useQuery({
    queryKey: ['recent-builds'],
    queryFn: buildApi.recent,
    refetchInterval: 5000,
  });

  const credentialsQuery = useQuery({
    queryKey: ['credentials'],
    queryFn: credentialApi.list,
    enabled: isAdmin,
  });
  const serversQuery = useQuery({ queryKey: ['servers'], queryFn: serverApi.list, enabled: isAdmin });
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: userApi.list, enabled: isAdmin });

  const [formOpen, setFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [triggerProject, setTriggerProject] = useState<ProjectSummary | null>(null);
  const [copyTarget, setCopyTarget] = useState<ProjectSummary | null>(null);
  const [loadingEdit, setLoadingEdit] = useState<number | null>(null);

  const projects = projectsQuery.data?.projects ?? [];
  const recentBuilds = recentQuery.data?.builds ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['recent-builds'] });
  };

  const openEdit = async (projectId: number) => {
    setLoadingEdit(projectId);
    try {
      const result = await projectApi.get(projectId);
      setEditingProject(result.project);
      setFormOpen(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载项目失败');
    } finally {
      setLoadingEdit(null);
    }
  };

  const removeProject = (project: ProjectSummary) => {
    modal.confirm({
      title: `删除项目「${project.name}」？`,
      content: '项目的发布记录、日志与工作区将一并删除，且无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await projectApi.remove(project.id);
          message.success('项目已删除');
          refresh();
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const columns: ColumnsType<ProjectSummary> = [
    {
      title: '项目',
      dataIndex: 'name',
      render: (_, record) => (
        <div>
          <Link to={`/projects/${record.id}`} style={{ fontWeight: 600 }}>
            {record.name}
          </Link>
          {record.description ? (
            <div className="mj-muted" style={{ fontSize: 12, marginTop: 2 }}>
              {record.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: '仓库',
      dataIndex: 'repoUrl',
      ellipsis: true,
      render: (value: string) => <span className="mj-mono">{value}</span>,
    },
    {
      title: '最近发布',
      key: 'lastBuild',
      width: 220,
      render: (_, record) =>
        record.lastBuild ? (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <BuildStatusTag status={record.lastBuild.status} />
              <Link to={`/projects/${record.id}/builds/${record.lastBuild.id}`} className="mj-mono">
                #{record.lastBuild.number}
              </Link>
            </Space>
            <span className="mj-muted" style={{ fontSize: 12 }}>
              {record.lastBuild.branch} · {fromNow(record.lastBuild.createdAt)}
            </span>
          </Space>
        ) : (
          <span className="mj-muted">尚未发布</span>
        ),
    },
    {
      title: '目标',
      dataIndex: 'targetCount',
      width: 80,
      render: (value: number) => `${value} 台`,
    },
    {
      title: '操作',
      key: 'actions',
      width: 320,
      render: (_, record) => (
        <Space size={4} onClick={(event) => event.stopPropagation()}>
          <Button type="link" size="small" onClick={() => setTriggerProject(record)}>
            发布
          </Button>
          <Button type="link" size="small" onClick={() => navigate(`/projects/${record.id}`)}>
            详情
          </Button>
          {isAdmin ? (
            <>
              <Button type="link" size="small" loading={loadingEdit === record.id} onClick={() => void openEdit(record.id)}>
                编辑
              </Button>
              <Button type="link" size="small" onClick={() => setCopyTarget(record)}>
                复制
              </Button>
              <Button type="link" size="small" danger onClick={() => removeProject(record)}>
                删除
              </Button>
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="项目"
        subtitle="管理发布项目、构建配置与目标服务器"
        extra={
          isAdmin ? (
            <Button
              type="primary"
              onClick={() => {
                setEditingProject(null);
                setFormOpen(true);
              }}
            >
              新建项目
            </Button>
          ) : null
        }
      />

      <Card className="mj-card" styles={{ body: { padding: projects.length === 0 ? 24 : 0 } }}>
        <Table<ProjectSummary>
          rowKey="id"
          columns={columns}
          dataSource={projects}
          loading={projectsQuery.isLoading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={isAdmin ? '还没有项目，先创建一个吧' : '暂无被授权的项目'}
              >
                {isAdmin ? (
                  <Button
                    type="primary"
                    onClick={() => {
                      setEditingProject(null);
                      setFormOpen(true);
                    }}
                  >
                    新建项目
                  </Button>
                ) : null}
              </Empty>
            ),
          }}
          onRow={(record) => ({
            onClick: () => navigate(`/projects/${record.id}`),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      <Card
        className="mj-card"
        title="最近发布"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            每 5 秒自动刷新
          </Typography.Text>
        }
        styles={{ body: { padding: recentBuilds.length === 0 ? 24 : 0 } }}
      >
        {recentBuilds.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无发布记录" />
        ) : (
          <List<RecentBuild>
            dataSource={recentBuilds}
            renderItem={(build) => (
              <List.Item
                style={{ cursor: 'pointer', paddingInline: 20 }}
                onClick={() => navigate(`/projects/${build.projectId}/builds/${build.id}`)}
                actions={[
                  <span className="mj-muted" key="time">
                    {formatTime(build.createdAt)}
                  </span>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={8} wrap>
                      <BuildStatusTag status={build.status} />
                      <Link to={`/projects/${build.projectId}`}>{build.projectName}</Link>
                      <span className="mj-mono">#{build.number}</span>
                      <Tag className="mj-mono">{build.branch}</Tag>
                    </Space>
                  }
                  description={
                    <Tooltip title={build.commitSha}>
                      <span className="mj-mono">{(build.commitSha || '').slice(0, 8) || '—'}</span>
                      <span className="mj-muted"> · {build.triggeredBy || '未知'} 触发</span>
                    </Tooltip>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <ProjectForm
        open={formOpen}
        project={editingProject}
        credentials={credentialsQuery.data?.credentials ?? []}
        servers={serversQuery.data?.servers ?? []}
        users={(usersQuery.data?.users ?? []).filter((user) => user.role === 'member' && !user.disabled)}
        onClose={() => setFormOpen(false)}
        onSaved={() => refresh()}
      />

      <CopyProjectModal
        open={Boolean(copyTarget)}
        project={copyTarget}
        onClose={() => setCopyTarget(null)}
        onCopied={(copied) => {
          refresh();
          navigate(`/projects/${copied.id}`);
        }}
      />

      <BuildTriggerModal
        open={Boolean(triggerProject)}
        project={
          triggerProject
            ? { id: triggerProject.id, name: triggerProject.name, defaultBranch: triggerProject.defaultBranch }
            : null
        }
        onClose={() => {
          setTriggerProject(null);
          refresh();
        }}
      />
    </div>
  );
}
