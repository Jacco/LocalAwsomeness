'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import styles from '../../../../accounts.module.css';

export default function SecurityGroupDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const accountId = typeof params.id === 'string' ? params.id : params.id?.[0] || '';
  const resourceKey = typeof params.resourceKey === 'string' ? decodeURIComponent(params.resourceKey) : params.resourceKey?.[0] ? decodeURIComponent(params.resourceKey[0]) : '';
  const region = searchParams.get('region') || 'Global';

  const [resourceData, setResourceData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchResourceData();
  }, [accountId, resourceKey]);

  const fetchResourceData = async () => {
    try {
      const response = await fetch(`/api/accounts/${accountId}/resources/vpc`);
      if (!response.ok) throw new Error('Failed to fetch resource data');
      const data = await response.json();

      let found = null;
      if (data.securityGroups && data.securityGroups[resourceKey]) {
        found = data.securityGroups[resourceKey];
      }

      if (!found) {
        throw new Error(`Security group ${resourceKey} not found`);
      }

      setResourceData(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resource data');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>Loading...</h1>
        </div>
      </div>
    );
  }

  if (error || !resourceData) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>Error</h1>
        </div>
        <p>{error || 'Resource not found'}</p>
      </div>
    );
  }

  const inboundRules = resourceData.InboundRules || [];
  const outboundRules = resourceData.OutboundRules || [];

  return (
    <div className={styles.container}>
      <div className={styles.header} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Link href={`/dashboard/accounts/${accountId}/resources/vpc?region=${region}`} className={styles.backButton}>← Back to VPC</Link>
          <h1>{resourceKey}</h1>
        </div>
      </div>

      {/* Basic Info */}
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px', marginBottom: '20px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Security Group Details</h2>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          <div>
            <label style={{ fontWeight: 'bold', color: '#666', fontSize: '0.9em' }}>Group ID</label>
            <p style={{ margin: '4px 0', color: '#333' }}>{resourceData.GroupId}</p>
          </div>
          <div>
            <label style={{ fontWeight: 'bold', color: '#666', fontSize: '0.9em' }}>Group Name</label>
            <p style={{ margin: '4px 0', color: '#333' }}>{resourceData.GroupName}</p>
          </div>
          <div>
            <label style={{ fontWeight: 'bold', color: '#666', fontSize: '0.9em' }}>VPC ID</label>
            <p style={{ margin: '4px 0', color: '#333' }}>{resourceData.VpcId}</p>
          </div>
        </div>
        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #eee' }}>
          <label style={{ fontWeight: 'bold', color: '#666', fontSize: '0.9em' }}>Description</label>
          <p style={{ margin: '4px 0', color: '#333' }}>{resourceData.Description}</p>
        </div>
      </div>

      {/* Inbound Rules */}
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px', marginBottom: '20px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Inbound Rules ({inboundRules.length})</h2>
        
        {inboundRules.length === 0 ? (
          <p style={{ color: '#999', fontStyle: 'italic' }}>No inbound rules</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.85em'
            }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#f5f5f5' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Protocol</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Port Range</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>CIDR / Source</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Description</th>
                </tr>
              </thead>
              <tbody>
                {inboundRules.map((rule: any, idx: number) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                    <td style={{ padding: '12px', color: '#333' }}>
                      {rule.IpProtocol === '-1' ? 'All' : rule.IpProtocol.toUpperCase()}
                    </td>
                    <td style={{ padding: '12px', color: '#333' }}>
                      {rule.FromPort && rule.ToPort
                        ? rule.FromPort === rule.ToPort
                          ? rule.FromPort
                          : `${rule.FromPort}-${rule.ToPort}`
                        : rule.IpProtocol === '-1' ? 'All' : 'N/A'}
                    </td>
                    <td style={{ padding: '12px', color: '#333' }}>
                      {rule.IpRanges?.length > 0
                        ? rule.IpRanges.map((r: any, i: number) => (
                            <div key={i}>{r.CidrIp}</div>
                          ))
                        : rule.UserIdGroupPairs?.length > 0
                        ? rule.UserIdGroupPairs.map((g: any, i: number) => (
                            <div key={i}>
                              <span style={{
                                display: 'inline-block',
                                padding: '2px 6px',
                                backgroundColor: '#e7f3ff',
                                color: '#0066cc',
                                borderRadius: '2px',
                                fontSize: '0.8em'
                              }}>
                                {g.GroupId}
                              </span>
                            </div>
                          ))
                        : 'N/A'}
                    </td>
                    <td style={{ padding: '12px', color: '#666', fontSize: '0.85em' }}>
                      {rule.IpRanges?.length > 0 && rule.IpRanges[0].Description}
                      {rule.UserIdGroupPairs?.length > 0 && rule.UserIdGroupPairs[0].Description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Outbound Rules */}
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '4px' }}>
        <h2 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.1em', color: '#333' }}>Outbound Rules ({outboundRules.length})</h2>
        
        {outboundRules.length === 0 ? (
          <p style={{ color: '#999', fontStyle: 'italic' }}>No outbound rules</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.85em'
            }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#f5f5f5' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Protocol</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Port Range</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>CIDR / Destination</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold', color: '#333' }}>Description</th>
                </tr>
              </thead>
              <tbody>
                {outboundRules.map((rule: any, idx: number) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                    <td style={{ padding: '12px', color: '#333' }}>
                      {rule.IpProtocol === '-1' ? 'All' : rule.IpProtocol.toUpperCase()}
                    </td>
                    <td style={{ padding: '12px', color: '#333' }}>
                      {rule.FromPort && rule.ToPort
                        ? rule.FromPort === rule.ToPort
                          ? rule.FromPort
                          : `${rule.FromPort}-${rule.ToPort}`
                        : rule.IpProtocol === '-1' ? 'All' : 'N/A'}
                    </td>
                    <td style={{ padding: '12px', color: '#333' }}>
                      {rule.IpRanges?.length > 0
                        ? rule.IpRanges.map((r: any, i: number) => (
                            <div key={i}>{r.CidrIp}</div>
                          ))
                        : rule.UserIdGroupPairs?.length > 0
                        ? rule.UserIdGroupPairs.map((g: any, i: number) => (
                            <div key={i}>
                              <span style={{
                                display: 'inline-block',
                                padding: '2px 6px',
                                backgroundColor: '#e7f3ff',
                                color: '#0066cc',
                                borderRadius: '2px',
                                fontSize: '0.8em'
                              }}>
                                {g.GroupId}
                              </span>
                            </div>
                          ))
                        : 'N/A'}
                    </td>
                    <td style={{ padding: '12px', color: '#666', fontSize: '0.85em' }}>
                      {rule.IpRanges?.length > 0 && rule.IpRanges[0].Description}
                      {rule.UserIdGroupPairs?.length > 0 && rule.UserIdGroupPairs[0].Description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
