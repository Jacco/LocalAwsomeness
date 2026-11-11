'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from '../../accounts/accounts.module.css';

interface S3Bucket {
  BucketName: string;
  Region: string;
  CreationDate: string;
  ObjectCount: number;
  Arn: string;
}

export default function S3Page() {
  const [buckets, setBuckets] = useState<S3Bucket[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [bucketData, setBucketData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchBuckets();
  }, []);

  const fetchBuckets = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/resources/s3');
      if (!response.ok) throw new Error('Failed to fetch buckets');
      const data = await response.json();
      setBuckets(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load buckets');
    } finally {
      setLoading(false);
    }
  };

  const fetchBucketContents = async (bucketName: string) => {
    try {
      const response = await fetch(`/api/resources/s3/buckets/${bucketName}`);
      if (!response.ok) throw new Error('Failed to fetch bucket contents');
      const data = await response.json();
      setBucketData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bucket contents');
    }
  };

  const handleBucketClick = (bucketName: string) => {
    setSelectedBucket(bucketName);
    fetchBucketContents(bucketName);
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href="/dashboard" className={styles.backButton}>← Back</Link>
          <h1>Loading S3 Buckets...</h1>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href="/dashboard" className={styles.backButton}>← Back</Link>
          <h1>S3 Buckets</h1>
        </div>
        <p style={{ color: 'red' }}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Link href="/dashboard" className={styles.backButton}>← Back</Link>
        <h1>S3 Storage Browser</h1>
      </div>

      <div style={{ display: 'flex', gap: '20px', minHeight: '500px' }}>
        {/* Buckets List */}
        <div style={{ flex: 1, borderRight: '1px solid #ddd', paddingRight: '20px' }}>
          <h3>Buckets ({buckets.length})</h3>
          <div className={styles.resourceCardList}>
            {buckets.map((bucket) => (
              <div
                key={bucket.BucketName}
                className={styles.resourceCard}
                style={{
                  cursor: 'pointer',
                  backgroundColor: selectedBucket === bucket.BucketName ? '#e3f2fd' : '#fff',
                  borderColor: selectedBucket === bucket.BucketName ? '#1976d2' : '#ddd',
                }}
                onClick={() => handleBucketClick(bucket.BucketName)}
              >
                <h4>📦 {bucket.BucketName}</h4>
                <div style={{ fontSize: '0.85em', color: '#666' }}>
                  <div>Region: {bucket.Region}</div>
                  <div>Objects: {bucket.ObjectCount}</div>
                  <div style={{ wordBreak: 'break-all', fontSize: '0.75em', marginTop: '8px' }}>
                    {bucket.Arn}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bucket Contents */}
        {selectedBucket && bucketData && (
          <div style={{ flex: 2, paddingLeft: '20px' }}>
            <h3>Objects in {bucketData.BucketName}</h3>
            <div style={{ marginBottom: '16px', fontSize: '0.85em', color: '#666' }}>
              <div>Created: {new Date(bucketData.CreationDate).toLocaleString()}</div>
              <div>Region: {bucketData.Region}</div>
            </div>
            {bucketData.Objects.length > 0 ? (
              <div className={styles.resourceDetailList}>
                {bucketData.Objects.map((obj: any) => (
                  <div key={obj.Key} className={styles.resourceDetailCard}>
                    <div className={styles.resourceDetailHeader}>
                      <h4>📄 {obj.Key}</h4>
                    </div>
                    <div style={{ fontSize: '0.85em', color: '#666', padding: '12px 0' }}>
                      <div>Size: {(obj.Size / 1024).toFixed(2)} KB</div>
                      <div>Type: {obj.ContentType}</div>
                      <div>Modified: {new Date(obj.LastModified).toLocaleString()}</div>
                    </div>
                    {obj.Body && (
                      <details>
                        <summary>Preview</summary>
                        <pre style={{
                          backgroundColor: '#f5f5f5',
                          padding: '12px',
                          borderRadius: '4px',
                          fontSize: '0.75em',
                          maxHeight: '200px',
                          overflow: 'auto',
                          marginTop: '8px',
                        }}>
                          {obj.Body}
                        </pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p>No objects in this bucket</p>
            )}
          </div>
        )}

        {!selectedBucket && (
          <div style={{ flex: 2, paddingLeft: '20px', color: '#999' }}>
            <p>Select a bucket to view its contents</p>
          </div>
        )}
      </div>
    </div>
  );
}
