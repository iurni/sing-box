package baidu

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"time"

	M "github.com/sagernet/sing/common/metadata"
)

const maxResponseHeaderBytes = 64 * 1024

// StatusError never includes gateway response bodies or authentication headers.
type StatusError struct {
	StatusCode int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("baidu CONNECT rejected with HTTP status %d", e.StatusCode)
}

func connect(ctx context.Context, conn net.Conn, destination M.Socksaddr, host, userAgent, secret string, timeout time.Duration) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return nil, err
	}
	stopCancel := context.AfterFunc(ctx, func() { conn.Close() })
	success := false
	defer func() {
		stopCancel()
		if !success {
			conn.Close()
		}
	}()
	request := []byte("CONNECT " + destination.String() + " HTTP/1.1\r\nHost: " + host + "\r\nUser-Agent: " + userAgent + "\r\nX-T5-Auth: " + secret + "\r\n\r\n")
	for len(request) > 0 {
		n, err := conn.Write(request)
		if err != nil {
			return nil, fmt.Errorf("write baidu CONNECT: %w", err)
		}
		if n <= 0 {
			return nil, io.ErrShortWrite
		}
		request = request[n:]
	}
	// Bound response parsing while retaining bytes received after the headers.
	limited := &io.LimitedReader{R: conn, N: maxResponseHeaderBytes}
	reader := bufio.NewReader(limited)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var networkError net.Error
		if errors.As(err, &networkError) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, fmt.Errorf("read baidu CONNECT response: %w", err)
		}
		// Parser errors may quote response bytes. A gateway could echo the
		// authentication header there, so do not include untrusted text in logs.
		return nil, errors.New("read baidu CONNECT response: invalid or oversized HTTP headers")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &StatusError{StatusCode: response.StatusCode}
	}
	limited.N = math.MaxInt64
	if !stopCancel() || ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err = conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	success = true
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}
