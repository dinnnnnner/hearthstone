"""Bounded shared-memory messages, signalled through private Unix sockets."""
import mmap
import os
from pathlib import Path
import pickle
import re
import socket
import struct
import uuid

CAPACITY=64*1024*1024
HEADER=struct.Struct('!Q')


class SharedEndpoint:
    def __init__(self, connection, memory):
        self.connection,self.memory=connection,memory

    def send(self, value):
        data=pickle.dumps(value,protocol=5)
        if len(data)>CAPACITY:raise ValueError('Inference message exceeds 64 MiB; reduce shard size')
        self.memory[:len(data)]=data
        self.connection.sendall(HEADER.pack(len(data)))

    def receive(self):
        header=self.connection.recv(HEADER.size,socket.MSG_WAITALL)
        if len(header)!=HEADER.size:raise ConnectionError('Inference peer closed')
        length=HEADER.unpack(header)[0]
        if not 0<length<=CAPACITY:raise ValueError('Invalid inference message size')
        # Both ends run our code under a private mode-700 directory. Never expose
        # this pickle protocol through a network listener or shared public path.
        return pickle.loads(self.memory[:length])

    def close(self):
        self.connection.close();self.memory.close()


class InferenceClient(SharedEndpoint):
    def __init__(self, address, timeout=180):
        address=Path(address);self.path=address.parent/(uuid.uuid4().hex+'.buffer')
        fd=os.open(self.path,os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
        try:os.ftruncate(fd,CAPACITY);memory=mmap.mmap(fd,CAPACITY)
        finally:os.close(fd)
        connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        connection.settimeout(timeout)
        try:
            connection.connect(str(address));connection.sendall(self.path.stem.encode('ascii'))
        except BaseException:
            connection.close();memory.close();self.path.unlink();raise
        super().__init__(connection,memory)

    def call(self, method, **payload):
        self.send(dict(method=method,**payload));reply=self.receive()
        if not reply['ok']:raise RuntimeError('Inference service: '+reply['error'])
        return reply['result']

    def close(self):
        super().close();self.path.unlink(missing_ok=True)


def accept_endpoint(listener, directory):
    connection,_=listener.accept();connection.settimeout(180)
    try:
        identity=connection.recv(32,socket.MSG_WAITALL).decode('ascii')
        if not re.fullmatch('[0-9a-f]{32}',identity):raise ValueError('Invalid shared buffer identity')
        path=Path(directory)/(identity+'.buffer')
        fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
        try:
            info=os.fstat(fd)
            if info.st_uid!=os.getuid() or info.st_size!=CAPACITY:raise ValueError('Invalid shared inference buffer')
            memory=mmap.mmap(fd,CAPACITY)
        finally:os.close(fd)
        return SharedEndpoint(connection,memory)
    except BaseException:connection.close();raise
