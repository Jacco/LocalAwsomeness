'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import styles from '../../../accounts.module.css';

interface S3Object {
  Key: string;
  Size: number;
  LastModified: string;
  StorageClass: string;
  Versions: Array<{
    VersionId: string;
    LastModified: string;
    Size: number;
    IsLatest: boolean;
    Content: string;
  }>;
}

interface S3Bucket {
  Name: string;
  CreationDate: string;
  Region: string;
  VersioningStatus: 'Enabled' | 'Disabled';
  Objects: { [key: string]: S3Object };
}

interface S3Data {
  [bucketName: string]: S3Bucket;
}

export default function S3Page() {
  const params = useParams();
  const searchParams = useSearchParams();
  const accountId = typeof params.id === 'string' ? params.id : params.id?.[0] || '';
  const region = searchParams.get('region') || 'eu-central-1';

  const [buckets, setBuckets] = useState<S3Data | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingBucket, setIsCreatingBucket] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [selectedObject, setSelectedObject] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  useEffect(() => {
    fetchBuckets();
  }, [accountId]);

  const fetchBuckets = async () => {
    try {
      const response = await fetch(
        `/api/accounts/${accountId}/resources/s3`
      );
      if (!response.ok) throw new Error('Failed to fetch buckets');
      const data = await response.json();
      setBuckets(data);
      if (Object.keys(data).length > 0 && !selectedBucket) {
        setSelectedBucket(Object.keys(data)[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load buckets');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBucket = async () => {
    if (!newBucketName.trim()) {
      setError('Bucket name cannot be empty');
      return;
    }

    try {
      const newBucket: S3Bucket = {
        Name: newBucketName,
        CreationDate: new Date().toISOString(),
        Region: region,
        VersioningStatus: 'Disabled',
        Objects: {}
      };

      const response = await fetch(
        `/api/accounts/${accountId}/resources/s3/persist`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: newBucketName,
            data: newBucket
          })
        }
      );

      if (!response.ok) throw new Error('Failed to create bucket');

      setBuckets({
        ...buckets,
        [newBucketName]: newBucket
      });
      setSelectedBucket(newBucketName);
      setNewBucketName('');
      setIsCreatingBucket(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error creating bucket');
    }
  };

  const handleDeleteBucket = async (bucketName: string) => {
    if (confirm(`Delete bucket "${bucketName}"? This will delete all objects.`)) {
      try {
        const response = await fetch(
          `/api/accounts/${accountId}/resources/s3/persist`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: bucketName })
          }
        );

        if (!response.ok) throw new Error('Failed to delete bucket');

        const newBuckets = { ...buckets };
        delete newBuckets[bucketName];
        setBuckets(newBuckets);
        if (selectedBucket === bucketName) {
          setSelectedBucket(Object.keys(newBuckets)[0] || null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error deleting bucket');
      }
    }
  };

  const handleUploadObject = async () => {
    if (!uploadFile || !selectedBucket) return;

    try {
      const content = await uploadFile.text();
      const bucket = buckets?.[selectedBucket];
      if (!bucket) return;

      const objectKey = uploadFile.name;
      const newObject: S3Object = {
        Key: objectKey,
        Size: uploadFile.size,
        LastModified: new Date().toISOString(),
        StorageClass: 'STANDARD',
        Versions: [
          {
            VersionId: `v-${Date.now()}`,
            LastModified: new Date().toISOString(),
            Size: uploadFile.size,
            IsLatest: true,
            Content: content
          }
        ]
      };

      const updatedBucket = {
        ...bucket,
        Objects: {
          ...bucket.Objects,
          [objectKey]: newObject
        }
      };

      const response = await fetch(
        `/api/accounts/${accountId}/resources/s3/persist`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: selectedBucket,
            data: updatedBucket
          })
        }
      );

      if (!response.ok) throw new Error('Failed to upload object');

      setBuckets({
        ...buckets,
        [selectedBucket]: updatedBucket
      });
      setUploadFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error uploading object');
    }
  };

  const handleDeleteObject = async (bucketName: string, objectKey: string) => {
    if (confirm(`Delete object "${objectKey}"?`)) {
      try {
        const bucket = buckets?.[bucketName];
        if (!bucket) return;

        const updatedObjects = { ...bucket.Objects };
        delete updatedObjects[objectKey];

        const updatedBucket = {
          ...bucket,
          Objects: updatedObjects
        };

        const response = await fetch(
          `/api/accounts/${accountId}/resources/s3/persist`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              key: bucketName,
              data: updatedBucket
            })
          }
        );

        if (!response.ok) throw new Error('Failed to delete object');

        setBuckets({
          ...buckets,
          [bucketName]: updatedBucket
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error deleting object');
      }
    }
  };

  const handleDownloadObject = (objectKey: string) => {
    if (!selectedBucket) return;
    const bucket = buckets?.[selectedBucket];
    if (!bucket) return;

    const obj = bucket.Objects[objectKey];
    if (!obj?.Versions?.[0]) return;

    const content = obj.Versions[0].Content;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = objectKey;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const handleToggleVersioning = async (bucketName: string) => {
    const bucket = buckets?.[bucketName];
    if (!bucket) return;

    const updatedBucket: S3Bucket = {
      ...bucket,
      VersioningStatus: bucket.VersioningStatus === 'Enabled' ? 'Disabled' : 'Enabled'
    };

    try {
      const response = await fetch(
        `/api/accounts/${accountId}/resources/s3/persist`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: bucketName,
            data: updatedBucket
          })
        }
      );

      if (!response.ok) throw new Error('Failed to toggle versioning');

      if (buckets) {
        setBuckets({
          ...buckets,
          [bucketName]: updatedBucket
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error updating versioning');
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>← Back</Link>
          <h1>Loading S3 Buckets...</h1>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>← Back</Link>
          <h1>S3 Buckets</h1>
        </div>
        <p style={{ color: 'red' }}>Error: {error}</p>
      </div>
    );
  }

  const bucketList = buckets ? Object.values(buckets) : [];
  const currentBucket = selectedBucket ? buckets?.[selectedBucket] : null;
  const objects = currentBucket ? Object.values(currentBucket.Objects) : [];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>← Back to Account</Link>
        <h1>S3 Buckets <span style={{ fontSize: '0.8em', color: '#666' }}>({region})</span></h1>
      </div>

      {error && <p style={{ color: 'red', marginBottom: '16px' }}>Error: {error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: '24px', width: '100%' }}>
        {/* Buckets Sidebar */}
        <div style={{ backgroundColor: '#f5f5f5', borderRadius: '4px', padding: '16px', color: '#000' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, color: '#000' }}>Buckets ({bucketList.length})</h3>
            <button
              onClick={() => setIsCreatingBucket(true)}
              style={{
                padding: '4px 8px',
                backgroundColor: '#4caf50',
                color: 'white',
                border: 'none',
                borderRadius: '3px',
                cursor: 'pointer',
                fontSize: '0.85em'
              }}
            >
              +
            </button>
          </div>

          {isCreatingBucket && (
            <div style={{ marginBottom: '12px', padding: '8px', backgroundColor: 'white', borderRadius: '3px' }}>
              <input
                type="text"
                placeholder="Bucket name"
                value={newBucketName}
                onChange={(e) => setNewBucketName(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px',
                  marginBottom: '8px',
                  border: '1px solid #ddd',
                  borderRadius: '3px',
                  boxSizing: 'border-box'
                }}
              />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={handleCreateBucket}
                  style={{
                    flex: 1,
                    padding: '6px',
                    backgroundColor: '#4caf50',
                    color: 'white',
                    border: 'none',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    fontSize: '0.85em'
                  }}
                >
                  Create
                </button>
                <button
                  onClick={() => {
                    setIsCreatingBucket(false);
                    setNewBucketName('');
                  }}
                  style={{
                    flex: 1,
                    padding: '6px',
                    backgroundColor: '#999',
                    color: 'white',
                    border: 'none',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    fontSize: '0.85em'
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {bucketList.map(bucket => (
            <div
              key={bucket.Name}
              style={{
                padding: '10px',
                marginBottom: '8px',
                backgroundColor: selectedBucket === bucket.Name ? '#0066cc' : 'white',
                color: selectedBucket === bucket.Name ? 'white' : 'black',
                borderRadius: '3px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}
              onClick={() => setSelectedBucket(bucket.Name)}
            >
              <span style={{ fontWeight: 'bold' }}>{bucket.Name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteBucket(bucket.Name);
                }}
                style={{
                  padding: '3px 6px',
                  backgroundColor: 'transparent',
                  color: selectedBucket === bucket.Name ? 'white' : '#f44336',
                  border: '1px solid currentColor',
                  borderRadius: '2px',
                  cursor: 'pointer',
                  fontSize: '0.75em'
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        {/* Objects View */}
        {currentBucket ? (
          <div style={{ backgroundColor: '#ffffff', padding: '16px', borderRadius: '4px' }}>
            <div style={{ backgroundColor: '#f9f9f9', padding: '16px', borderRadius: '4px', marginBottom: '16px', color: '#000' }}>
              <h3>{currentBucket.Name}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '12px' }}>
                <div>
                  <strong>Created:</strong> {new Date(currentBucket.CreationDate).toLocaleDateString()}
                </div>
                <div>
                  <strong>Region:</strong> {currentBucket.Region}
                </div>
                <div>
                  <strong>Versioning:</strong>
                  <button
                    onClick={() => handleToggleVersioning(currentBucket.Name)}
                    style={{
                      marginLeft: '8px',
                      padding: '4px 8px',
                      backgroundColor: currentBucket.VersioningStatus === 'Enabled' ? '#4caf50' : '#999',
                      color: 'white',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '0.9em'
                    }}
                  >
                    {currentBucket.VersioningStatus}
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  style={{ flex: 1 }}
                />
                <button
                  onClick={handleUploadObject}
                  disabled={!uploadFile}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: uploadFile ? '#4caf50' : '#ccc',
                    color: 'white',
                    border: 'none',
                    borderRadius: '3px',
                    cursor: uploadFile ? 'pointer' : 'not-allowed',
                    fontSize: '0.9em'
                  }}
                >
                  Upload
                </button>
              </div>
            </div>

            <h3>Objects ({objects.length})</h3>
            {objects.length === 0 ? (
              <p style={{ color: '#999' }}>No objects in this bucket</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.9em'
                }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #ddd', color: '#000' }}>
                      <th style={{ padding: '12px', textAlign: 'left', color: '#000' }}>Key</th>
                      <th style={{ padding: '12px', textAlign: 'left', color: '#000' }}>Size</th>
                      <th style={{ padding: '12px', textAlign: 'left', color: '#000' }}>Modified</th>
                      <th style={{ padding: '12px', textAlign: 'left', color: '#000' }}>Storage Class</th>
                      <th style={{ padding: '12px', textAlign: 'center', color: '#000' }}>Versions</th>
                      <th style={{ padding: '12px', textAlign: 'center', color: '#000' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {objects.map((obj) => (
                      <tr key={obj.Key} style={{ borderBottom: '1px solid #eee', color: '#000' }}>
                        <td
                          style={{
                            padding: '12px',
                            cursor: 'pointer',
                            color: '#0066cc',
                            textDecoration: 'underline'
                          }}
                          onClick={() => setSelectedObject(selectedObject === obj.Key ? null : obj.Key)}
                        >
                          {obj.Key}
                        </td>
                        <td style={{ padding: '12px', color: '#000' }}>
                          {(obj.Size / 1024).toFixed(2)} KB
                        </td>
                        <td style={{ padding: '12px', color: '#000' }}>
                          {new Date(obj.LastModified).toLocaleString()}
                        </td>
                        <td style={{ padding: '12px', color: '#000' }}>
                          {obj.StorageClass}
                        </td>
                        <td style={{ padding: '12px', textAlign: 'center', color: '#000' }}>
                          {obj.Versions.length}
                        </td>
                        <td style={{ padding: '12px', textAlign: 'center' }}>
                          <button
                            onClick={() => handleDownloadObject(obj.Key)}
                            style={{
                              padding: '4px 8px',
                              marginRight: '4px',
                              backgroundColor: '#2196F3',
                              color: 'white',
                              border: 'none',
                              borderRadius: '3px',
                              cursor: 'pointer',
                              fontSize: '0.85em'
                            }}
                          >
                            Download
                          </button>
                          <button
                            onClick={() => handleDeleteObject(currentBucket.Name, obj.Key)}
                            style={{
                              padding: '4px 8px',
                              backgroundColor: '#f44336',
                              color: 'white',
                              border: 'none',
                              borderRadius: '3px',
                              cursor: 'pointer',
                              fontSize: '0.85em'
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selectedObject && currentBucket.Objects[selectedObject] && (
              <div style={{ marginTop: '24px', backgroundColor: '#f9f9f9', padding: '16px', borderRadius: '4px' }}>
                <h3>Versions: {selectedObject}</h3>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '0.85em'
                  }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #ddd', color: '#000' }}>
                        <th style={{ padding: '10px', textAlign: 'left', color: '#000' }}>Version ID</th>
                        <th style={{ padding: '10px', textAlign: 'left', color: '#000' }}>Date</th>
                        <th style={{ padding: '10px', textAlign: 'left', color: '#000' }}>Size</th>
                        <th style={{ padding: '10px', textAlign: 'center', color: '#000' }}>Latest</th>
                        <th style={{ padding: '10px', textAlign: 'center', color: '#000' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentBucket.Objects[selectedObject].Versions.map((v) => (
                        <tr key={v.VersionId} style={{ borderBottom: '1px solid #eee', color: '#000' }}>
                          <td style={{ padding: '10px', fontFamily: 'monospace', color: '#000' }}>
                            {v.VersionId}
                          </td>
                          <td style={{ padding: '10px', color: '#000' }}>
                            {new Date(v.LastModified).toLocaleString()}
                          </td>
                          <td style={{ padding: '10px', color: '#000' }}>
                            {(v.Size / 1024).toFixed(2)} KB
                          </td>
                          <td style={{ padding: '10px', textAlign: 'center', color: '#000' }}>
                            {v.IsLatest ? '✓' : ''}
                          </td>
                          <td style={{ padding: '10px', textAlign: 'center' }}>
                            <button
                              style={{
                                padding: '4px 8px',
                                backgroundColor: '#2196F3',
                                color: 'white',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer',
                                fontSize: '0.8em'
                              }}
                              onClick={() => {
                                const content = v.Content;
                                const blob = new Blob([content], { type: 'text/plain' });
                                const url = window.URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `${selectedObject}.v${v.VersionId}`;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                window.URL.revokeObjectURL(url);
                              }}
                            >
                              Download
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
            <p>No buckets found. Create a bucket to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
