import { Button, Empty, Tooltip, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { buildApi } from '../api';
import type { BuildSummary } from '../types';
import { BuildStatusTag } from './StatusTag';
import { formatDuration, formatTime, shortSha } from '../format';

interface Props {
  projectId?: number;
  showProject?: boolean;
  emptyText?: string;
}

export function BuildsTable({ projectId, showProject = false, emptyText = '还没有发布记录' }: Props) {
  const navigate = useNavigate();
  const query = useInfiniteQuery({
    queryKey: ['builds', projectId ?? 'all'],
    queryFn: ({ pageParam }) =>
      buildApi.list({ projectId, limit: 10, beforeId: pageParam as number | undefined }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (queryState) => {
      const pages = queryState.state.data?.pages ?? [];
      const running = pages.some((page) =>
        page.builds.some((build) => build.status === 'running' || build.status === 'queued'),
      );
      return running ? 2000 : false;
    },
  });

  const builds = (query.data?.pages ?? []).flatMap((page) => page.builds);

  const columns: ColumnsType<BuildSummary> = [
    {
      title: '编号',
      dataIndex: 'number',
      width: 90,
      render: (_, record) => (
        <Link to={`/projects/${record.projectId}/builds/${record.id}`} className="mj-mono">
          #{record.number}
        </Link>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: BuildSummary['status']) => <BuildStatusTag status={status} />,
    },
    ...(showProject
      ? [
          {
            title: '项目',
            dataIndex: 'projectName',
            width: 160,
            ellipsis: true,
            render: (value: string, record: BuildSummary) => (
              <Link to={`/projects/${record.projectId}`}>{value}</Link>
            ),
          } as ColumnsType<BuildSummary>[number],
        ]
      : []),
    {
      title: '分支',
      dataIndex: 'branch',
      width: 160,
      ellipsis: true,
      render: (value: string) => <span className="mj-mono">{value}</span>,
    },
    {
      title: '提交',
      dataIndex: 'commitSha',
      ellipsis: true,
      render: (value: string | null, record) => (
        <Tooltip title={record.commitSubject || value || ''}>
          <span className="mj-mono">{shortSha(value)}</span>
          {record.commitSubject ? <span className="mj-muted"> {record.commitSubject}</span> : null}
        </Tooltip>
      ),
    },
    {
      title: '触发人',
      dataIndex: 'triggeredBy',
      width: 110,
      render: (value: string | null) => value || '-',
    },
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      width: 170,
      render: (value: string | null, record) => formatTime(value || record.createdAt, 'MM-DD HH:mm:ss'),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 100,
      render: (value: number | null) => (value === null ? '-' : formatDuration(value)),
    },
    {
      title: '结果',
      dataIndex: 'error',
      ellipsis: true,
      render: (value: string | null) =>
        value ? (
          <Tooltip title={value}>
            <Typography.Text type="danger" ellipsis style={{ maxWidth: 220 }}>
              {value}
            </Typography.Text>
          </Tooltip>
        ) : (
          <span className="mj-muted">-</span>
        ),
    },
  ];

  return (
    <div>
      <Table<BuildSummary>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={builds}
        loading={query.isLoading}
        pagination={false}
        scroll={{ x: 960 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} /> }}
        onRow={(record) => ({
          onClick: () => navigate(`/projects/${record.projectId}/builds/${record.id}`),
          style: { cursor: 'pointer' },
        })}
      />
      {query.hasNextPage ? (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
            加载更多
          </Button>
        </div>
      ) : null}
    </div>
  );
}
