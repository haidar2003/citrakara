// components/dashboard/wallet/TransactionsPage.tsx
"use client";

import React, { useState, useMemo } from "react";
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Chip,
  TextField,
  MenuItem,
  FormControl,
  InputLabel,
  Select,
  InputAdornment,
  Grid,
  Stack,
  Tooltip,
  IconButton,
  SelectChangeEvent,
  Button,
  Breadcrumbs,
  Link as MuiLink,
  Alert,
} from "@mui/material";
import {
  Search,
  FilterList,
  NorthEast,
  SouthWest,
  Info,
  ArrowBack,
  LocalAtm,
  Home,
  NavigateNext,
} from "@mui/icons-material";
import Link from "next/link";

// Types
interface Transaction {
  _id: string;
  type: "hold" | "release" | "refund" | "revision_fee" | "change_fee";
  from: "client" | "escrow";
  to: "escrow" | "artist" | "client";
  amount: number;
  note?: string;
  createdAt: string;
  contractId?: string;
}

interface TransactionsPageProps {
  username: string;
  transactions: Transaction[];
}

// Main component
const TransactionsPage: React.FC<TransactionsPageProps> = ({
  username,
  transactions,
}) => {
  // State for pagination
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // State for filters
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>("all");

  // Format date
  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Format currency
  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  // Get transaction type label
  const getTransactionTypeLabel = (type: string): string => {
    switch (type) {
      case "hold":
        return "Pembayaran Ditahan";
      case "release":
        return "Pembayaran Dirilis";
      case "refund":
        return "Uang Kembali";
      case "revision_fee":
        return "Biaya Revisi";
      case "change_fee":
        return "Biaya Ganti Kontrak";
      default:
        return type;
    }
  };

  // Get transaction color
  const getTransactionColor = (type: string, to: string): string => {
    if (to === "client" && type === "refund") return "success";
    if (to === "artist" && type === "release") return "success";
    if (type === "hold" || type === "revision_fee" || type === "change_fee")
      return "warning";
    return "default";
  };

  // Get transaction direction icon
  const getTransactionIcon = (type: string, from: string, to: string) => {
    if (from === "client") {
      return <SouthWest fontSize="small" color="warning" />;
    } else if (to === "client") {
      return <NorthEast fontSize="small" color="success" />;
    } else if (to === "artist") {
      return <NorthEast fontSize="small" color="success" />;
    } else {
      return <Info fontSize="small" color="info" />;
    }
  };

  // Apply date filter
  const applyDateFilter = (
    transaction: Transaction,
    filter: string
  ): boolean => {
    if (filter === "all") return true;

    const txnDate = new Date(transaction.createdAt);
    const now = new Date();

    switch (filter) {
      case "today":
        return txnDate.toDateString() === now.toDateString();
      case "week":
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(now.getDate() - 7);
        return txnDate >= oneWeekAgo;
      case "month":
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(now.getMonth() - 1);
        return txnDate >= oneMonthAgo;
      case "year":
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        return txnDate >= oneYearAgo;
      default:
        return true;
    }
  };

  // Filter transactions
  const filteredTransactions = useMemo(() => {
    return transactions.filter((transaction) => {
      const matchesSearch =
        !searchTerm ||
        transaction.note?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        transaction.contractId
          ?.toLowerCase()
          .includes(searchTerm.toLowerCase()) ||
        getTransactionTypeLabel(transaction.type)
          .toLowerCase()
          .includes(searchTerm.toLowerCase());

      const matchesType =
        typeFilter === "all" || transaction.type === typeFilter;

      const matchesDate = applyDateFilter(transaction, dateFilter);

      return matchesSearch && matchesType && matchesDate;
    });
  }, [transactions, searchTerm, typeFilter, dateFilter]);

  // Get total amounts
  const totalIncoming = useMemo(() => {
    return filteredTransactions
      .filter((tx) => tx.to === "client" || tx.to === "artist")
      .reduce((sum, tx) => sum + tx.amount, 0);
  }, [filteredTransactions]);

  const totalOutgoing = useMemo(() => {
    return filteredTransactions
      .filter((tx) => tx.from === "client")
      .reduce((sum, tx) => sum + tx.amount, 0);
  }, [filteredTransactions]);

  // Handle pagination changes
  const handleChangePage = (event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  // Handle filter changes
  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
    setPage(0);
  };

  const handleTypeFilterChange = (event: SelectChangeEvent<string>) => {
    setTypeFilter(event.target.value);
    setPage(0);
  };

  const handleDateFilterChange = (event: SelectChangeEvent<string>) => {
    setDateFilter(event.target.value);
    setPage(0);
  };

  return (
    <Box
      sx={{
        py: 4,
        maxWidth: "100%",
        animation: "fadeIn 0.3s ease-in-out",
        "@keyframes fadeIn": {
          "0%": { opacity: 0, transform: "translateY(10px)" },
          "100%": { opacity: 1, transform: "translateY(0)" },
        },
      }}
    >
      {/* Navigation */}
      <Box sx={{ mb: 3 }}>
        <Breadcrumbs separator={<NavigateNext fontSize="small" />}>
          <MuiLink
            component={Link}
            href={`/${username}/dashboard`}
            underline="hover"
            color="inherit"
            sx={{ display: "flex", alignItems: "center" }}
          >
            <Home fontSize="small" sx={{ mr: 0.5 }} />
            Dashboard
          </MuiLink>
          <MuiLink
            component={Link}
            href={`/${username}/dashboard/wallet`}
            underline="hover"
            color="inherit"
            sx={{ display: "flex", alignItems: "center" }}
          >
            <LocalAtm fontSize="small" sx={{ mr: 0.5 }} />
            Dompet
          </MuiLink>
          <Typography
            color="text.primary"
            sx={{ display: "flex", alignItems: "center" }}
          >
            Transaksi
          </Typography>
        </Breadcrumbs>

        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mt: 2,
          }}
        >
          <Typography variant="h5" fontWeight="500">
            Riwayat Transaksi
          </Typography>
          <Button
            component={Link}
            href={`/${username}/dashboard/wallet`}
            variant="outlined"
            startIcon={<ArrowBack />}
            size="small"
          >
            Kembali ke Dompet
          </Button>
        </Box>
      </Box>

      {/* Summary */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <Paper
            sx={{
              p: 2,
              borderRadius: 2,
              bgcolor: "success.light",
              color: "white",
            }}
          >
            <Typography variant="subtitle2">Total Masuk</Typography>
            <Typography variant="h5" fontWeight="bold">
              {formatCurrency(totalIncoming)}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper
            sx={{
              p: 2,
              borderRadius: 2,
              bgcolor: "warning.light",
              color: "white",
            }}
          >
            <Typography variant="subtitle2">Total Keluar</Typography>
            <Typography variant="h5" fontWeight="bold">
              {formatCurrency(totalOutgoing)}
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* Filters */}
      <Paper sx={{ p: 3, mb: 3, borderRadius: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={4}>
            <TextField
              fullWidth
              label="Cari transaksi"
              variant="outlined"
              value={searchTerm}
              onChange={handleSearchChange}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search />
                  </InputAdornment>
                ),
              }}
              placeholder="Cari ID, jenis, atau catatan kontrak"
              size="small"
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <FormControl fullWidth variant="outlined" size="small">
              <InputLabel id="type-filter-label">Jenis Transaksi</InputLabel>
              <Select
                labelId="type-filter-label"
                value={typeFilter}
                onChange={handleTypeFilterChange}
                label="Transaction Type"
                startAdornment={
                  <InputAdornment position="start">
                    <FilterList />
                  </InputAdornment>
                }
              >
                <MenuItem value="all">Semua</MenuItem>
                <MenuItem value="hold">Pembayaran Ditahan</MenuItem>
                <MenuItem value="release">Pembayaran Dirilis</MenuItem>
                <MenuItem value="refund">Uang Kembali</MenuItem>
                <MenuItem value="revision_fee">Biaya Revisi</MenuItem>
                <MenuItem value="change_fee">Biaya Ganti Kontrak</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} md={3}>
            <FormControl fullWidth variant="outlined" size="small">
              <InputLabel id="date-filter-label">Time Period</InputLabel>
              <Select
                labelId="date-filter-label"
                value={dateFilter}
                onChange={handleDateFilterChange}
                label="Time Period"
              >
                <MenuItem value="all">Semua</MenuItem>
                <MenuItem value="today">Hari Ini</MenuItem>
                <MenuItem value="week">7 Hari Terakhir</MenuItem>
                <MenuItem value="month">30 Hari Terakhir</MenuItem>
                <MenuItem value="year">Tahun Lalu</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid
            item
            xs={12}
            md={2}
            sx={{
              display: "flex",
              justifyContent: { xs: "flex-start", md: "flex-end" },
              alignItems: "center",
            }}
          >
            <Chip
              label={`${filteredTransactions.length} transaction(s)`}
              color="primary"
              variant="outlined"
            />
          </Grid>
        </Grid>
      </Paper>

      {/* No data state */}
      {filteredTransactions.length === 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <Typography variant="body1">
            Tidak ada transaksi yang cocok.
          </Typography>
          <Typography variant="body2">
            Coba ganti kriteria pencarian.
          </Typography>
        </Alert>
      )}

      {/* Transactions table */}
      {filteredTransactions.length > 0 && (
        <TableContainer
          component={Paper}
          sx={{ borderRadius: 2, mb: 2, overflow: "hidden" }}
        >
          <Table sx={{ minWidth: 650 }} aria-label="transactions table">
            <TableHead sx={{ bgcolor: "action.hover" }}>
              <TableRow>
                <TableCell sx={{ fontWeight: "bold" }}>Tanggal</TableCell>
                <TableCell sx={{ fontWeight: "bold" }}>Jenis</TableCell>
                <TableCell sx={{ fontWeight: "bold" }}>Alur</TableCell>
                <TableCell sx={{ fontWeight: "bold" }} align="right">
                  Jumlah
                </TableCell>
                <TableCell sx={{ fontWeight: "bold" }}>Kontrak</TableCell>
                <TableCell sx={{ fontWeight: "bold" }}>Catatan</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredTransactions
                .slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
                .map((transaction) => (
                  <TableRow
                    key={transaction._id}
                    hover
                    sx={{
                      "&:nth-of-type(odd)": { bgcolor: "rgba(0, 0, 0, 0.02)" },
                    }}
                  >
                    <TableCell>{formatDate(transaction.createdAt)}</TableCell>
                    <TableCell>
                      <Chip
                        label={getTransactionTypeLabel(transaction.type)}
                        color={
                          getTransactionColor(
                            transaction.type,
                            transaction.to
                          ) as
                            | "default"
                            | "primary"
                            | "secondary"
                            | "error"
                            | "info"
                            | "success"
                            | "warning"
                        }
                        size="small"
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="body2" fontWeight="medium">
                          {transaction.from}
                        </Typography>
                        {getTransactionIcon(
                          transaction.type,
                          transaction.from,
                          transaction.to
                        )}
                        <Typography variant="body2" fontWeight="medium">
                          {transaction.to}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Typography
                        fontWeight="bold"
                        color={
                          transaction.to === "artist" ||
                          transaction.to === "client"
                            ? "success.main"
                            : transaction.from === "client"
                            ? "warning.main"
                            : "text.primary"
                        }
                      >
                        {formatCurrency(transaction.amount)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {transaction.contractId ? (
                        <Tooltip
                          title={`Contract ID: ${transaction.contractId}`}
                        >
                          <Typography
                            variant="body2"
                            sx={{
                              maxWidth: 150,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {transaction.contractId.substring(0, 8)}...
                          </Typography>
                        </Tooltip>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: "flex", alignItems: "center" }}>
                        <Typography
                          variant="body2"
                          sx={{
                            maxWidth: 200,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {transaction.note || "—"}
                        </Typography>
                        {transaction.note && (
                          <Tooltip title={transaction.note}>
                            <IconButton size="small">
                              <Info fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Pagination */}
      {filteredTransactions.length > 0 && (
        <TablePagination
          rowsPerPageOptions={[5, 10, 25, 50]}
          component="div"
          count={filteredTransactions.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={handleChangePage}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      )}
    </Box>
  );
};

export default TransactionsPage;
